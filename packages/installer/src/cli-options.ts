import { resolve } from "node:path";
import { COMPANION_LAUNCH_URL } from "@val-bridge/protocol";

export type CliOptions = {
  installRoot?: string;
  apiUrl?: string;
  launchUrl?: typeof COMPANION_LAUNCH_URL;
  repairLaunchHandler: boolean;
  help: boolean;
};

export function parseCliOptions(arguments_: string[]) {
  const options: CliOptions = { help: false, repairLaunchHandler: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--install-dir") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--install-dir requires a path.");
      options.installRoot = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--release-api") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--release-api requires a URL.");
      options.apiUrl = value;
      index += 1;
      continue;
    }
    if (argument === "--launch-url") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--launch-url requires a URL.");
      if (value !== COMPANION_LAUNCH_URL) {
        throw new Error("The companion launch URL is invalid.");
      }
      options.launchUrl = value;
      index += 1;
      continue;
    }
    if (argument === "--repair-launch-handler") {
      options.repairLaunchHandler = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

export function assertSupportedNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(
      `Node.js 24 or newer is required; found ${process.versions.node}.`,
    );
  }
}

export function installOptionsFromCli(options: CliOptions) {
  return {
    ...(options.installRoot ? { installRoot: options.installRoot } : {}),
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
  };
}
