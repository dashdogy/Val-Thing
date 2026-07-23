import {
  assertSupportedNode,
  installOptionsFromCli,
  parseCliOptions,
} from "./cli-options.js";
import { installLatest } from "./install-core.js";

const help = `Val Bridge updater

Usage:
  node update.mjs [--install-dir <path>] [--release-api <url>]
`;

async function main() {
  assertSupportedNode();
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  await installLatest(installOptionsFromCli(options));
}

await main().catch((error: unknown) => {
  console.error(
    `Update failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
