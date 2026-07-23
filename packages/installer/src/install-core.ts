import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  type ResolvedRelease,
  type ResolvedReleaseAsset,
  readResponseBytes,
  resolveLatestRelease,
  SOURCE_REPOSITORY,
} from "./release.js";
import { defaultInstallRoot, isPathInside, runtimePaths } from "./paths.js";
import { extractZip } from "./zip.js";

type Logger = Pick<Console, "log" | "warn">;

type InstallOptions = {
  installRoot?: string;
  apiUrl?: string;
  fetcher?: typeof fetch;
  logger?: Logger;
};

type CurrentInstall = {
  version: string;
  installed_at: string;
  server: string;
  extension: string;
  source: {
    repository: string;
    commit: string;
    tag: string;
  };
};

export type InstalledState = {
  version: string;
  installRoot: string;
  runtimeRoot: string;
  serverPath: string;
  extensionPath: string;
  startPath: string;
  updatePath: string;
};

export type InstallResult = InstalledState & {
  updated: boolean;
  releaseUrl?: string;
};

const silentLogger: Logger = {
  log() {},
  warn() {},
};

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safeChild(parent: string, child: string) {
  if (!isPathInside(parent, child)) {
    throw new Error(`Refusing to modify a path outside ${parent}.`);
  }
  return child;
}

async function safeRemove(parent: string, child: string) {
  await rm(safeChild(parent, child), { recursive: true, force: true });
}

async function readJson(path: string) {
  return JSON.parse(
    (await readFile(path, "utf8")).replace(/^\uFEFF/, ""),
  ) as unknown;
}

async function writeAtomic(path: string, contents: string) {
  const temporary = `${path}.${randomUUID().replaceAll("-", "")}.tmp`;
  await writeFile(temporary, contents, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" &&
      (error as NodeJS.ErrnoException).code !== "EPERM"
    ) {
      throw error;
    }
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

async function acquireInstallLock(root: string) {
  const path = join(root, "install.lock");
  const deadline = Date.now() + 30_000;
  await mkdir(root, { recursive: true });
  while (Date.now() < deadline) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      );
      return async () => {
        await handle.close();
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const details = await stat(path);
        if (Date.now() - details.mtimeMs > 10 * 60_000) {
          await rm(path, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw statError;
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error("Another bridge install or update is still running.");
}

async function downloadAsset(
  asset: ResolvedReleaseAsset,
  fetcher: typeof fetch,
) {
  const response = await fetcher(asset.downloadUrl, {
    headers: { "user-agent": "Val-Bridge-Installer" },
  });
  if (!response.ok) {
    throw new Error(
      `Release download ${asset.name} returned ${response.status}.`,
    );
  }
  const lengthHeader = response.headers.get("content-length");
  const declaredLength =
    lengthHeader === null ? undefined : Number(lengthHeader);
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength !== asset.size
  ) {
    throw new Error(`Release size check failed for ${asset.name}.`);
  }
  const buffer = await readResponseBytes(response, asset.size);
  if (buffer.length !== asset.size) {
    throw new Error(`Release size check failed for ${asset.name}.`);
  }
  const checksum = createHash("sha256").update(buffer).digest("hex");
  if (checksum !== asset.sha256.toLowerCase()) {
    throw new Error(`SHA-256 verification failed for ${asset.name}.`);
  }
  return buffer;
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function parseCurrent(value: unknown): CurrentInstall {
  if (!value || typeof value !== "object") {
    throw new Error("The installed runtime metadata is invalid.");
  }
  const current = value as Partial<CurrentInstall>;
  if (
    typeof current.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(current.version) ||
    typeof current.server !== "string" ||
    typeof current.extension !== "string" ||
    !current.source ||
    current.source.repository !== SOURCE_REPOSITORY ||
    current.source.tag !== `v${current.version}` ||
    !/^[a-f0-9]{40}$/i.test(current.source.commit)
  ) {
    throw new Error("The installed runtime metadata is invalid.");
  }
  return current as CurrentInstall;
}

export async function readInstalledState(
  installRoot = defaultInstallRoot(),
): Promise<InstalledState | null> {
  const paths = runtimePaths(installRoot);
  if (!(await exists(paths.current))) return null;
  const current = parseCurrent(await readJson(paths.current));
  const serverPath = resolve(paths.runtime, current.server);
  const extensionPath = resolve(paths.runtime, current.extension);
  if (
    !isPathInside(paths.runtime, serverPath) ||
    !isPathInside(paths.runtime, extensionPath) ||
    !(await exists(serverPath)) ||
    !(await exists(join(extensionPath, "manifest.json"))) ||
    !(await exists(paths.start)) ||
    !(await exists(paths.update))
  ) {
    return null;
  }
  return {
    version: current.version,
    installRoot: paths.root,
    runtimeRoot: paths.runtime,
    serverPath,
    extensionPath,
    startPath: paths.start,
    updatePath: paths.update,
  };
}

async function validatePayload(payloadRoot: string, release: ResolvedRelease) {
  const required = [
    "server.mjs",
    "launcher.mjs",
    "update.mjs",
    "version.json",
    join("extension", "manifest.json"),
  ];
  for (const path of required) {
    if (!(await exists(join(payloadRoot, path)))) {
      throw new Error(`The release bundle is missing ${path}.`);
    }
  }

  const versionInfo = (await readJson(
    join(payloadRoot, "version.json"),
  )) as Record<string, unknown>;
  const extensionManifest = (await readJson(
    join(payloadRoot, "extension", "manifest.json"),
  )) as Record<string, unknown>;
  if (
    versionInfo.version !== release.version ||
    extensionManifest.version !== release.version
  ) {
    throw new Error("The release bundle version does not match latest.json.");
  }
  const source =
    versionInfo.source && typeof versionInfo.source === "object"
      ? (versionInfo.source as Record<string, unknown>)
      : {};
  if (
    source.repository !== release.source.repository ||
    source.commit !== release.source.commit ||
    source.tag !== release.source.tag
  ) {
    throw new Error("The release bundle source does not match latest.json.");
  }
}

async function installVersion(
  payloadRoot: string,
  release: ResolvedRelease,
  installRoot: string,
) {
  const paths = runtimePaths(installRoot);
  await mkdir(paths.versions, { recursive: true });
  const versionRoot = safeChild(
    paths.versions,
    join(paths.versions, release.version),
  );
  const nextVersion = safeChild(
    paths.versions,
    join(
      paths.versions,
      `.next-${release.version}-${randomUUID().replaceAll("-", "")}`,
    ),
  );
  await mkdir(nextVersion, { recursive: true });
  try {
    for (const name of [
      "server.mjs",
      "launcher.mjs",
      "update.mjs",
      "version.json",
    ]) {
      await copyFile(join(payloadRoot, name), join(nextVersion, name));
    }
    await safeRemove(paths.versions, versionRoot);
    await rename(nextVersion, versionRoot);
  } catch (error) {
    await safeRemove(paths.versions, nextVersion);
    throw error;
  }

  const extensionNext = safeChild(
    paths.runtime,
    join(paths.runtime, `.extension-next-${randomUUID().replaceAll("-", "")}`),
  );
  const extensionPrevious = safeChild(
    paths.runtime,
    join(paths.runtime, ".extension-previous"),
  );
  await cp(join(payloadRoot, "extension"), extensionNext, {
    recursive: true,
  });
  await safeRemove(paths.runtime, extensionPrevious);
  let previousMoved = false;
  try {
    if (await exists(paths.extension)) {
      await rename(paths.extension, extensionPrevious);
      previousMoved = true;
    }
    await rename(extensionNext, paths.extension);
    await safeRemove(paths.runtime, extensionPrevious);
  } catch (error) {
    await safeRemove(paths.runtime, extensionNext);
    if (
      previousMoved &&
      !(await exists(paths.extension)) &&
      (await exists(extensionPrevious))
    ) {
      await rename(extensionPrevious, paths.extension);
    }
    throw error;
  }

  await copyFile(join(versionRoot, "launcher.mjs"), paths.start);
  await copyFile(join(versionRoot, "update.mjs"), paths.update);
  const shellStart = `#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec node "$SCRIPT_DIR/start.mjs" "$@"
`;
  const shellUpdate = `#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec node "$SCRIPT_DIR/update.mjs" "$@"
`;
  await writeAtomic(join(paths.runtime, "start-val-bridge"), shellStart);
  await writeAtomic(join(paths.runtime, "update-val-bridge"), shellUpdate);
  await writeAtomic(
    join(paths.runtime, "Start Val Bridge.command"),
    shellStart,
  );
  await writeAtomic(
    join(paths.runtime, "Start Val Bridge.cmd"),
    '@echo off\r\nnode "%~dp0start.mjs" %*\r\n',
  );
  await writeAtomic(
    join(paths.runtime, "Update Val Bridge.cmd"),
    '@echo off\r\nnode "%~dp0update.mjs" %*\r\n',
  );
  if (process.platform !== "win32") {
    await Promise.all([
      chmod(join(paths.runtime, "start-val-bridge"), 0o755),
      chmod(join(paths.runtime, "update-val-bridge"), 0o755),
      chmod(join(paths.runtime, "Start Val Bridge.command"), 0o755),
    ]);
  }

  const current: CurrentInstall = {
    version: release.version,
    installed_at: new Date().toISOString(),
    server: relative(paths.runtime, join(versionRoot, "server.mjs")),
    extension: relative(paths.runtime, paths.extension),
    source: release.source,
  };
  await writeAtomic(paths.current, `${JSON.stringify(current, null, 2)}\n`);
  await writeFile(paths.reloadMarker, "reload\n", "utf8");
}

export async function installLatest(
  options: InstallOptions = {},
): Promise<InstallResult> {
  const installRoot = resolve(options.installRoot ?? defaultInstallRoot());
  const logger = options.logger ?? console;
  const fetcher = options.fetcher ?? fetch;
  const release = await resolveLatestRelease({
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    fetcher,
  });
  const existing = await readInstalledState(installRoot);
  if (existing && compareVersions(existing.version, release.version) >= 0) {
    logger.log(`Val Bridge v${existing.version} is already installed.`);
    return {
      ...existing,
      updated: false,
      releaseUrl: release.releaseUrl,
    };
  }

  const releaseLock = await acquireInstallLock(installRoot);
  let temporaryRoot: string | undefined;
  try {
    temporaryRoot = await mkdtemp(join(tmpdir(), "val-bridge-install-"));
    const afterLock = await readInstalledState(installRoot);
    if (afterLock && compareVersions(afterLock.version, release.version) >= 0) {
      return {
        ...afterLock,
        updated: false,
        releaseUrl: release.releaseUrl,
      };
    }

    logger.log(`Downloading Val Bridge v${release.version}...`);
    const archive = await downloadAsset(
      release.assets.portable_bundle,
      fetcher,
    );
    const payloadRoot = join(temporaryRoot, "payload");
    await extractZip(archive, payloadRoot);
    await validatePayload(payloadRoot, release);
    await installVersion(payloadRoot, release, installRoot);
    const installed = await readInstalledState(installRoot);
    if (!installed) {
      throw new Error("The installed runtime failed validation.");
    }
    logger.log(`Installed Val Bridge v${installed.version}.`);
    return {
      ...installed,
      updated: true,
      releaseUrl: release.releaseUrl,
    };
  } finally {
    if (temporaryRoot) {
      await safeRemove(tmpdir(), temporaryRoot);
    }
    await releaseLock();
  }
}

export function quietInstallOptions(
  options: InstallOptions = {},
): InstallOptions {
  return { ...options, logger: silentLogger };
}

export function displayPath(path: string) {
  return basename(path) === path || !path.includes(" ") ? path : `"${path}"`;
}
