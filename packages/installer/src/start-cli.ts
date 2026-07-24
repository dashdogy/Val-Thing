import { spawn } from "node:child_process";
import { dirname } from "node:path";
import {
  assertSupportedNode,
  installOptionsFromCli,
  parseCliOptions,
} from "./cli-options.js";
import {
  installLatest,
  readInstalledState,
  repairCompanionLaunchProtocol,
} from "./install-core.js";
import { defaultInstallRoot } from "./paths.js";

const help = `Val Bridge launcher

Usage:
  node start.mjs [--install-dir <path>] [--release-api <url>]
`;

function companionPort() {
  const parsed = Number.parseInt(process.env.VAL_BRIDGE_PORT ?? "8787", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : 8787;
}

async function companionIsRunning(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  assertSupportedNode();
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  const installRoot = options.installRoot ?? defaultInstallRoot();
  if (options.repairLaunchHandler) {
    await repairCompanionLaunchProtocol(installRoot);
    return;
  }
  const port = companionPort();
  if (await companionIsRunning(port)) {
    console.log(`Val Bridge is already running at http://127.0.0.1:${port}/v1`);
    return;
  }

  let installed;
  console.log("Checking for Val Bridge updates...");
  try {
    installed = await installLatest(installOptionsFromCli(options));
  } catch (error) {
    installed = await readInstalledState(installRoot);
    if (!installed) throw error;
    console.warn(
      `Update check failed; starting v${installed.version}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  console.log(`Starting Val Bridge v${installed.version}...`);
  const child = spawn(process.execPath, [installed.serverPath], {
    cwd: dirname(installed.serverPath),
    env: {
      ...process.env,
      VAL_BRIDGE_CONFIG_DIR: installed.installRoot,
    },
    stdio: "inherit",
    windowsHide: false,
  });
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  process.exitCode = result.code ?? (result.signal ? 1 : 0);
}

await main().catch((error: unknown) => {
  console.error(
    `Start failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
