import { homedir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";

type InstallPathOptions = {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
};

export function defaultInstallRoot(options: InstallPathOptions = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const pathApi = platform === "win32" ? win32 : posix;
  const configured = environment.VAL_BRIDGE_INSTALL_DIR;
  if (configured) return pathApi.resolve(configured);

  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    return pathApi.join(
      localAppData && pathApi.isAbsolute(localAppData)
        ? localAppData
        : pathApi.join(homeDirectory, "AppData", "Local"),
      "ValOpenAIBridge",
    );
  }
  if (platform === "darwin") {
    return pathApi.join(
      homeDirectory,
      "Library",
      "Application Support",
      "ValOpenAIBridge",
    );
  }

  const xdgDataHome = environment.XDG_DATA_HOME;
  return pathApi.join(
    xdgDataHome && pathApi.isAbsolute(xdgDataHome)
      ? xdgDataHome
      : pathApi.join(homeDirectory, ".local", "share"),
    "val-openai-bridge",
  );
}

export function isPathInside(parent: string, candidate: string) {
  const relation = relative(resolve(parent), resolve(candidate));
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(relation)
  );
}

export function runtimePaths(installRoot: string) {
  const root = resolve(installRoot);
  const runtime = join(root, "runtime");
  return {
    root,
    runtime,
    versions: join(runtime, "versions"),
    extension: join(runtime, "extension"),
    current: join(runtime, "current.json"),
    start: join(runtime, "start.mjs"),
    update: join(runtime, "update.mjs"),
    reloadMarker: join(root, "reload-extension"),
    lock: join(root, "install.lock"),
  };
}
