import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { writeDeterministicZip } from "./deterministic-zip.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");
const releaseDirectory = join(projectRoot, "release");
const temporaryDirectory = join(projectRoot, ".tmp");
const extensionRoot = join(projectRoot, "packages", "extension");
const installerSource = join(projectRoot, "packages", "installer", "src");
const repository = "https://github.com/dashdogy/Val-Thing";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function currentCommit() {
  const candidate =
    process.env.GITHUB_SHA?.trim() ||
    (
      await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: projectRoot,
      })
    ).stdout.trim();
  if (!/^[a-f0-9]{40}$/i.test(candidate)) {
    throw new Error("The release source commit is not a full Git SHA.");
  }
  return candidate.toLowerCase();
}

function buildTimestamp() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch) {
    const milliseconds = Number(epoch) * 1_000;
    if (!Number.isSafeInteger(milliseconds)) {
      throw new Error("SOURCE_DATE_EPOCH must be a valid Unix timestamp.");
    }
    return new Date(milliseconds).toISOString();
  }
  return new Date().toISOString();
}

async function bundle(entryPoint, outputFile) {
  await build({
    entryPoints: [entryPoint],
    outfile: outputFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
}

const rootPackage = await readJson(join(projectRoot, "package.json"));
const version = rootPackage.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("The root package version is not valid semantic version.");
}

const versionFiles = [
  join(projectRoot, "packages", "protocol", "package.json"),
  join(projectRoot, "packages", "server", "package.json"),
  join(projectRoot, "packages", "extension", "package.json"),
  join(projectRoot, "packages", "installer", "package.json"),
];
for (const path of versionFiles) {
  const packageJson = await readJson(path);
  if (packageJson.version !== version) {
    throw new Error(
      `Release version mismatch: ${path} is ${packageJson.version}; expected ${version}.`,
    );
  }
}

const extensionManifest = await readJson(
  join(extensionRoot, "dist", "manifest.json"),
);
if (extensionManifest.version !== version) {
  throw new Error(
    `Extension manifest is ${extensionManifest.version}; expected ${version}.`,
  );
}

const tag = process.env.RELEASE_TAG?.trim() || `v${version}`;
if (tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match version ${version}.`);
}

const commit = await currentCommit();
const publishedAt = buildTimestamp();
const portableArchiveName = `val-openai-local-bridge-${version}.zip`;
const extensionArchiveName = `val-openai-local-bridge-extension-${version}.zip`;
const installerName = "install.mjs";
const portableArchivePath = join(releaseDirectory, portableArchiveName);
const extensionArchivePath = join(releaseDirectory, extensionArchiveName);
const installerPath = join(releaseDirectory, installerName);

await mkdir(releaseDirectory, { recursive: true });
await mkdir(temporaryDirectory, { recursive: true });
const stagingRoot = await mkdtemp(join(temporaryDirectory, "friend-release-"));
const payloadRoot = join(stagingRoot, "payload");

try {
  await mkdir(payloadRoot, { recursive: true });
  await Promise.all([
    bundle(
      join(projectRoot, "packages", "server", "src", "index.ts"),
      join(payloadRoot, "server.mjs"),
    ),
    bundle(
      join(installerSource, "start-cli.ts"),
      join(payloadRoot, "launcher.mjs"),
    ),
    bundle(
      join(installerSource, "update-cli.ts"),
      join(payloadRoot, "update.mjs"),
    ),
    bundle(join(installerSource, "install-cli.ts"), installerPath),
  ]);

  await cp(join(extensionRoot, "dist"), join(payloadRoot, "extension"), {
    recursive: true,
  });
  await writeFile(
    join(payloadRoot, "version.json"),
    `${JSON.stringify(
      {
        version,
        source: { repository, commit, tag },
        built_at: publishedAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const portableArchive = await writeDeterministicZip(
    payloadRoot,
    portableArchivePath,
  );
  const extensionDetails = await stat(extensionArchivePath);
  const installerDetails = await stat(installerPath);
  const extensionSha256 = await sha256File(extensionArchivePath);
  const installerSha256 = await sha256File(installerPath);
  const latest = {
    schema_version: 1,
    version,
    channel: "stable",
    published_at: publishedAt,
    minimum_node_version: "24.0.0",
    source: { repository, commit, tag },
    assets: {
      portable_bundle: {
        name: portableArchiveName,
        sha256: portableArchive.sha256,
        size: portableArchive.size,
      },
      extension: {
        name: extensionArchiveName,
        sha256: extensionSha256,
        size: extensionDetails.size,
      },
      installer: {
        name: installerName,
        sha256: installerSha256,
        size: installerDetails.size,
      },
    },
  };
  const latestPath = join(releaseDirectory, "latest.json");
  await writeFile(latestPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  const latestSha256 = await sha256File(latestPath);

  await writeFile(
    `${portableArchivePath}.sha256`,
    `${portableArchive.sha256}  ${portableArchiveName}\n`,
    "utf8",
  );
  await writeFile(
    join(releaseDirectory, "SHA256SUMS.txt"),
    [
      `${portableArchive.sha256}  ${portableArchiveName}`,
      `${extensionSha256}  ${extensionArchiveName}`,
      `${installerSha256}  ${installerName}`,
      `${latestSha256}  ${basename(latestPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(
    `Packaged ${portableArchive.entries} files: ${portableArchivePath}`,
  );
  console.log(`SHA-256: ${portableArchive.sha256}`);
  console.log(`Portable installer: ${installerPath}`);
  console.log(`Release manifest: ${latestPath}`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
