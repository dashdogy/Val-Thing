import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type RepairCommand = {
  file: string;
  arguments: string[];
};

type RepairOptions = {
  installRoot?: string;
  nodePath?: string;
  environment?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "warn">;
  runCommand?: (file: string, arguments_: string[]) => Promise<unknown>;
};

export function launchHandlerRepairCommand(
  installRoot: string,
  nodePath = process.execPath,
): RepairCommand {
  const root = resolve(installRoot);
  return {
    file: nodePath,
    arguments: [
      join(root, "runtime", "start.mjs"),
      "--install-dir",
      root,
      "--repair-launch-handler",
    ],
  };
}

export async function repairInstalledLaunchHandler(
  options: RepairOptions = {},
) {
  const environment = options.environment ?? process.env;
  const installRoot =
    options.installRoot ?? environment.VAL_BRIDGE_CONFIG_DIR?.trim();
  if (
    !installRoot ||
    environment.VAL_BRIDGE_SKIP_PROTOCOL_REGISTRATION === "1"
  ) {
    return false;
  }

  const command = launchHandlerRepairCommand(
    installRoot,
    options.nodePath ?? process.execPath,
  );
  const runCommand =
    options.runCommand ??
    ((file: string, arguments_: string[]) =>
      execFileAsync(file, arguments_, {
        env: environment,
        timeout: 15_000,
        windowsHide: true,
      }));
  try {
    await runCommand(command.file, command.arguments);
    return true;
  } catch (error) {
    (options.logger ?? console).warn(
      `Could not repair the extension launch button: ${
        error instanceof Error ? error.message : String(error)
      }. The companion will continue starting.`,
    );
    return false;
  }
}
