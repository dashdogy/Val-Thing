import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
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

async function bundle(entryPoint, outputFile, options = {}) {
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
    alias: {
      "jsonc-parser": "jsonc-parser/lib/esm/main.js",
    },
    banner: {
      js: `${options.executable ? "#!/usr/bin/env node\n" : ""}import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);`,
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
const oneLineInstallerName = "install.tgz";
const portableArchivePath = join(releaseDirectory, portableArchiveName);
const extensionArchivePath = join(releaseDirectory, extensionArchiveName);
const installerPath = join(releaseDirectory, installerName);
const oneLineInstallerPath = join(releaseDirectory, oneLineInstallerName);

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
    bundle(join(installerSource, "install-cli.ts"), installerPath, {
      executable: true,
    }),
  ]);
  await chmod(installerPath, 0o755);

  const npmInstallerRoot = join(stagingRoot, "npm-installer");
  const npmInstallerEntry = join(npmInstallerRoot, installerName);
  await mkdir(npmInstallerRoot, { recursive: true });
  await cp(installerPath, npmInstallerEntry);
  await chmod(npmInstallerEntry, 0o755);
  await writeFile(
    join(npmInstallerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "val-thing-installer",
        version,
        description: "Cross-platform Val Thing installer.",
        type: "module",
        bin: { "val-thing-install": installerName },
        engines: { node: ">=24" },
        repository: {
          type: "git",
          url: "git+https://github.com/dashdogy/Val-Thing.git",
        },
        license: "UNLICENSED",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("npm_execpath is required to build install.tgz.");
  }
  const packed = await execFileAsync(
    process.execPath,
    [
      npmCli,
      "pack",
      npmInstallerRoot,
      "--pack-destination",
      stagingRoot,
      "--json",
      "--ignore-scripts",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
    },
  );
  const packResult = JSON.parse(packed.stdout);
  const packDetails = Array.isArray(packResult)
    ? packResult[0]
    : Object.values(packResult)[0];
  const packedName = packDetails?.filename;
  if (typeof packedName !== "string" || basename(packedName) !== packedName) {
    throw new Error("npm pack did not return a safe package filename.");
  }
  await rm(oneLineInstallerPath, { force: true });
  await rename(join(stagingRoot, packedName), oneLineInstallerPath);

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
  const oneLineInstallerDetails = await stat(oneLineInstallerPath);
  const extensionSha256 = await sha256File(extensionArchivePath);
  const installerSha256 = await sha256File(installerPath);
  const oneLineInstallerSha256 = await sha256File(oneLineInstallerPath);
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
      `${oneLineInstallerSha256}  ${oneLineInstallerName}`,
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
  console.log(
    `One-line installer: ${oneLineInstallerPath} (${oneLineInstallerDetails.size} bytes)`,
  );
  console.log(`Release manifest: ${latestPath}`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
