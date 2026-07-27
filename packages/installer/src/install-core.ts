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
import { registerCompanionLaunchProtocol } from "./protocol-handler.js";
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

export type InstallCommitStage =
  | "version"
  | "extension"
  | "start"
  | "update"
  | "shell-start"
  | "shell-update"
  | "macos-start"
  | "windows-start"
  | "windows-update"
  | "current"
  | "reload-marker";

export type InstallTransactionHooks = {
  afterCommit?: (stage: InstallCommitStage) => void | Promise<void>;
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

async function registerInstalledLaunchProtocol(
  installed: InstalledState,
  logger: Logger,
) {
  if (process.env.VAL_BRIDGE_SKIP_PROTOCOL_REGISTRATION === "1") return;
  await registerCompanionLaunchProtocol({
    installRoot: installed.installRoot,
    startPath: installed.startPath,
    logger,
  });
}

async function tryRegisterInstalledLaunchProtocol(
  installed: InstalledState,
  logger: Logger,
) {
  try {
    await registerInstalledLaunchProtocol(installed, logger);
  } catch (error) {
    logger.warn(
      `Could not register the extension launch button: ${
        error instanceof Error ? error.message : String(error)
      }. The generated start command still works.`,
    );
  }
}

export async function repairCompanionLaunchProtocol(
  installRoot = defaultInstallRoot(),
  logger: Logger = console,
) {
  const installed = await readInstalledState(installRoot);
  if (!installed) {
    throw new Error("Val Bridge is not installed in the selected directory.");
  }
  await registerInstalledLaunchProtocol(installed, logger);
  return installed;
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

type SwapOperation = {
  stage: InstallCommitStage;
  target: string;
  staged: string;
  backup: string;
  previousMoved: boolean;
  committed: boolean;
};

async function rollbackInstall(
  installRoot: string,
  operations: SwapOperation[],
) {
  const failures: unknown[] = [];
  for (const operation of operations.toReversed()) {
    try {
      if (operation.committed && (await exists(operation.target))) {
        await safeRemove(installRoot, operation.target);
      }
      if (operation.previousMoved && (await exists(operation.backup))) {
        await rename(operation.backup, operation.target);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export async function installVersion(
  payloadRoot: string,
  release: ResolvedRelease,
  installRoot: string,
  hooks: InstallTransactionHooks = {},
) {
  const paths = runtimePaths(installRoot);
  await mkdir(paths.runtime, { recursive: true });
  await mkdir(paths.versions, { recursive: true });
  const versionRoot = safeChild(
    paths.versions,
    join(paths.versions, release.version),
  );
  const transactionRoot = safeChild(
    paths.root,
    join(
      paths.root,
      `.install-transaction-${release.version}-${randomUUID().replaceAll("-", "")}`,
    ),
  );
  const stagedRoot = join(transactionRoot, "next");
  const backupRoot = join(transactionRoot, "previous");
  const stagedVersion = join(stagedRoot, "version");
  const stagedExtension = join(stagedRoot, "extension");
  const stagedStart = join(stagedRoot, "start.mjs");
  const stagedUpdate = join(stagedRoot, "update.mjs");
  const stagedShellStart = join(stagedRoot, "start-val-bridge");
  const stagedShellUpdate = join(stagedRoot, "update-val-bridge");
  const stagedMacStart = join(stagedRoot, "Start Val Bridge.command");
  const stagedWindowsStart = join(stagedRoot, "Start Val Bridge.cmd");
  const stagedWindowsUpdate = join(stagedRoot, "Update Val Bridge.cmd");
  const stagedCurrent = join(stagedRoot, "current.json");
  const stagedReloadMarker = join(stagedRoot, "reload-extension");
  const shellStart = `#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec node "$SCRIPT_DIR/start.mjs" "$@"
`;
  const shellUpdate = `#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec node "$SCRIPT_DIR/update.mjs" "$@"
`;
  const current: CurrentInstall = {
    version: release.version,
    installed_at: new Date().toISOString(),
    server: relative(paths.runtime, join(versionRoot, "server.mjs")),
    extension: relative(paths.runtime, paths.extension),
    source: release.source,
  };
  const operations: SwapOperation[] = [
    {
      stage: "version",
      target: versionRoot,
      staged: stagedVersion,
      backup: join(backupRoot, "version"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "extension",
      target: paths.extension,
      staged: stagedExtension,
      backup: join(backupRoot, "extension"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "start",
      target: paths.start,
      staged: stagedStart,
      backup: join(backupRoot, "start.mjs"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "update",
      target: paths.update,
      staged: stagedUpdate,
      backup: join(backupRoot, "update.mjs"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "shell-start",
      target: join(paths.runtime, "start-val-bridge"),
      staged: stagedShellStart,
      backup: join(backupRoot, "start-val-bridge"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "shell-update",
      target: join(paths.runtime, "update-val-bridge"),
      staged: stagedShellUpdate,
      backup: join(backupRoot, "update-val-bridge"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "macos-start",
      target: join(paths.runtime, "Start Val Bridge.command"),
      staged: stagedMacStart,
      backup: join(backupRoot, "Start Val Bridge.command"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "windows-start",
      target: join(paths.runtime, "Start Val Bridge.cmd"),
      staged: stagedWindowsStart,
      backup: join(backupRoot, "Start Val Bridge.cmd"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "windows-update",
      target: join(paths.runtime, "Update Val Bridge.cmd"),
      staged: stagedWindowsUpdate,
      backup: join(backupRoot, "Update Val Bridge.cmd"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "current",
      target: paths.current,
      staged: stagedCurrent,
      backup: join(backupRoot, "current.json"),
      previousMoved: false,
      committed: false,
    },
    {
      stage: "reload-marker",
      target: paths.reloadMarker,
      staged: stagedReloadMarker,
      backup: join(backupRoot, "reload-extension"),
      previousMoved: false,
      committed: false,
    },
  ];
  const activeOperations: SwapOperation[] = [];

  try {
    await mkdir(stagedVersion, { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    for (const name of [
      "server.mjs",
      "launcher.mjs",
      "update.mjs",
      "version.json",
    ]) {
      await copyFile(join(payloadRoot, name), join(stagedVersion, name));
    }
    await cp(join(payloadRoot, "extension"), stagedExtension, {
      recursive: true,
    });
    await copyFile(join(stagedVersion, "launcher.mjs"), stagedStart);
    await copyFile(join(stagedVersion, "update.mjs"), stagedUpdate);
    await writeFile(stagedShellStart, shellStart, "utf8");
    await writeFile(stagedShellUpdate, shellUpdate, "utf8");
    await writeFile(stagedMacStart, shellStart, "utf8");
    await writeFile(
      stagedWindowsStart,
      '@echo off\r\nnode "%~dp0start.mjs" %*\r\n',
      "utf8",
    );
    await writeFile(
      stagedWindowsUpdate,
      '@echo off\r\nnode "%~dp0update.mjs" %*\r\n',
      "utf8",
    );
    await writeFile(
      stagedCurrent,
      `${JSON.stringify(current, null, 2)}\n`,
      "utf8",
    );
    await writeFile(stagedReloadMarker, "reload\n", "utf8");
    if (process.platform !== "win32") {
      await Promise.all([
        chmod(stagedShellStart, 0o755),
        chmod(stagedShellUpdate, 0o755),
        chmod(stagedMacStart, 0o755),
      ]);
    }

    for (const operation of operations) {
      activeOperations.push(operation);
      if (await exists(operation.target)) {
        await rename(operation.target, operation.backup);
        operation.previousMoved = true;
      }
      await rename(operation.staged, operation.target);
      operation.committed = true;
      await hooks.afterCommit?.(operation.stage);
    }

    const installed = await readInstalledState(installRoot);
    if (!installed || installed.version !== release.version) {
      throw new Error("The installed runtime failed validation.");
    }
  } catch (error) {
    const rollbackFailures = await rollbackInstall(
      paths.root,
      activeOperations,
    );
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        `The update failed and could not be fully rolled back. Recovery files remain in ${transactionRoot}.`,
      );
    }
    await safeRemove(paths.root, transactionRoot);
    throw error;
  }
  await safeRemove(paths.root, transactionRoot);
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
    await tryRegisterInstalledLaunchProtocol(existing, logger);
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
      await tryRegisterInstalledLaunchProtocol(afterLock, logger);
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
    await tryRegisterInstalledLaunchProtocol(installed, logger);
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
