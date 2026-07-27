import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResolvedRelease } from "../src/release.js";
import {
  installVersion,
  readInstalledState,
  type InstallCommitStage,
} from "../src/install-core.js";

function release(version: string): ResolvedRelease {
  const asset = {
    name: "unused.zip",
    sha256: "a".repeat(64),
    size: 1,
    downloadUrl: "https://example.com/unused.zip",
  };
  return {
    schema_version: 1,
    version,
    channel: "stable",
    published_at: "2026-07-27T00:00:00.000Z",
    minimum_node_version: "24.0.0",
    source: {
      repository: "https://github.com/dashdogy/Val-Thing",
      commit: version === "1.0.0" ? "1".repeat(40) : "2".repeat(40),
      tag: `v${version}`,
    },
    releaseUrl: `https://example.com/releases/v${version}`,
    assets: {
      portable_bundle: { ...asset, name: "portable.zip" },
      extension: { ...asset, name: "extension.zip" },
      installer: { ...asset, name: "install.mjs" },
    },
  };
}

async function createPayload(root: string, version: string) {
  const payload = join(root, `payload-${version}`);
  await mkdir(join(payload, "extension"), { recursive: true });
  await Promise.all([
    writeFile(join(payload, "server.mjs"), `// server ${version}\n`, "utf8"),
    writeFile(
      join(payload, "launcher.mjs"),
      `// launcher ${version}\n`,
      "utf8",
    ),
    writeFile(join(payload, "update.mjs"), `// update ${version}\n`, "utf8"),
    writeFile(
      join(payload, "version.json"),
      `${JSON.stringify({ version })}\n`,
      "utf8",
    ),
    writeFile(
      join(payload, "extension", "manifest.json"),
      `${JSON.stringify({ manifest_version: 3, version })}\n`,
      "utf8",
    ),
  ]);
  return payload;
}

test("a failed update restores the complete prior install", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "val-installer-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "installed");
  const firstPayload = await createPayload(root, "1.0.0");
  const secondPayload = await createPayload(root, "2.0.0");

  for (const faultStage of [
    "extension",
    "start",
    "current",
    "reload-marker",
  ] as const satisfies readonly InstallCommitStage[]) {
    await rm(installRoot, { recursive: true, force: true });
    await installVersion(firstPayload, release("1.0.0"), installRoot);

    await assert.rejects(
      installVersion(secondPayload, release("2.0.0"), installRoot, {
        afterCommit(stage) {
          if (stage === faultStage) {
            throw new Error(`Injected failure after ${stage}.`);
          }
        },
      }),
      new RegExp(`Injected failure after ${faultStage}`),
    );

    const installed = await readInstalledState(installRoot);
    assert.equal(installed?.version, "1.0.0");
    assert.equal(
      await readFile(join(installRoot, "runtime", "start.mjs"), "utf8"),
      "// launcher 1.0.0\n",
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(installRoot, "runtime", "extension", "manifest.json"),
          "utf8",
        ),
      ),
      { manifest_version: 3, version: "1.0.0" },
    );
    assert.equal(
      (
        JSON.parse(
          await readFile(join(installRoot, "runtime", "current.json"), "utf8"),
        ) as { version: string }
      ).version,
      "1.0.0",
    );
    assert.equal(
      (await readdir(installRoot)).some((name) =>
        name.startsWith(".install-transaction-"),
      ),
      false,
    );
  }
});

test("a successful transaction activates every new runtime artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "val-installer-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "installed");
  const firstPayload = await createPayload(root, "1.0.0");
  const secondPayload = await createPayload(root, "2.0.0");

  await installVersion(firstPayload, release("1.0.0"), installRoot);
  await installVersion(secondPayload, release("2.0.0"), installRoot);

  const installed = await readInstalledState(installRoot);
  assert.equal(installed?.version, "2.0.0");
  assert.equal(
    await readFile(join(installRoot, "runtime", "start.mjs"), "utf8"),
    "// launcher 2.0.0\n",
  );
  assert.equal(
    (
      JSON.parse(
        await readFile(
          join(installRoot, "runtime", "extension", "manifest.json"),
          "utf8",
        ),
      ) as { version: string }
    ).version,
    "2.0.0",
  );
});
