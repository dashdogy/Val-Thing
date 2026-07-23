import { displayPath, installLatest } from "./install-core.js";
import {
  assertSupportedNode,
  installOptionsFromCli,
  parseCliOptions,
} from "./cli-options.js";

const help = `Val Bridge installer

Usage:
  npx --yes https://github.com/dashdogy/Val-Thing/releases/latest/download/install.tgz
  node install.mjs [--install-dir <path>] [--release-api <url>]
`;

async function main() {
  assertSupportedNode();
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  const result = await installLatest(installOptionsFromCli(options));

  console.log("");
  console.log(`Extension folder: ${displayPath(result.extensionPath)}`);
  console.log("Load that folder once as an unpacked Chromium extension.");
  console.log(`Start command: node ${displayPath(result.startPath)}`);
}

await main().catch((error: unknown) => {
  console.error(
    `Install failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
