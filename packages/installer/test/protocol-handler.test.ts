import assert from "node:assert/strict";
import test from "node:test";
import { COMPANION_LAUNCH_URL } from "@val-bridge/protocol";
import { launchProtocolRegistrationPlan } from "../src/protocol-handler.js";

test("builds a per-user Windows protocol registration", () => {
  const plan = launchProtocolRegistrationPlan({
    platform: "win32",
    installRoot: "C:\\Users\\friend\\AppData\\Local\\ValOpenAIBridge",
    startPath:
      "C:\\Users\\friend\\AppData\\Local\\ValOpenAIBridge\\runtime\\start.mjs",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    environment: {},
    homeDirectory: "C:\\Users\\friend",
  });

  assert.equal(plan.launchUrl, COMPANION_LAUNCH_URL);
  assert.deepEqual(plan.files, []);
  assert.equal(plan.commands.length, 3);
  assert.equal(plan.commands[0]?.file, "reg.exe");
  assert.ok(
    plan.commands.every((command) =>
      command.arguments.some((argument) =>
        argument.includes("HKCU\\Software\\Classes\\val-openai-bridge"),
      ),
    ),
  );
  assert.ok(
    plan.commands[2]?.arguments.includes(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\friend\\AppData\\Local\\ValOpenAIBridge\\runtime\\start.mjs" --install-dir "C:\\Users\\friend\\AppData\\Local\\ValOpenAIBridge" --launch-url "%1"',
    ),
  );
});

test("builds a macOS URL-handler app that opens the launcher in Terminal", () => {
  const plan = launchProtocolRegistrationPlan({
    platform: "darwin",
    installRoot: "/Users/friend/Library/Application Support/ValOpenAIBridge",
    startPath:
      "/Users/friend/Library/Application Support/ValOpenAIBridge/runtime/start.mjs",
    nodePath: "/opt/homebrew/bin/node",
    environment: {},
    homeDirectory: "/Users/friend",
  });
  const infoPlist = plan.files.find((file) =>
    file.path.endsWith("/Contents/Info.plist"),
  );
  const applicationLauncher = plan.files.find((file) =>
    file.path.endsWith("/Contents/MacOS/val-bridge-launcher"),
  );
  const terminalLauncher = plan.files.find((file) =>
    file.path.endsWith("/Launch Val Bridge.command"),
  );

  assert.match(infoPlist?.contents ?? "", /val-openai-bridge/);
  assert.match(
    infoPlist?.contents ?? "",
    /<key>CFBundleTypeRole<\/key>\s*<string>Shell<\/string>/,
  );
  assert.doesNotMatch(infoPlist?.contents ?? "", /LSBackgroundOnly/);
  assert.match(applicationLauncher?.contents ?? "", /open -a Terminal/);
  assert.match(terminalLauncher?.contents ?? "", /runtime\/start\.mjs/);
  assert.match(terminalLauncher?.contents ?? "", /--install-dir/);
  assert.equal(applicationLauncher?.mode, 0o755);
  assert.equal(terminalLauncher?.mode, 0o755);
  assert.match(plan.commands[0]?.file ?? "", /lsregister$/);
});

test("builds a Linux desktop URL handler whose wrapper ignores the URL", () => {
  const plan = launchProtocolRegistrationPlan({
    platform: "linux",
    installRoot: "/home/friend/.local/share/val-openai-bridge",
    startPath: "/home/friend/.local/share/val-openai-bridge/runtime/start.mjs",
    nodePath: "/home/friend/.local/node/bin/node",
    environment: { XDG_DATA_HOME: "/home/friend/.data" },
    homeDirectory: "/home/friend",
  });
  const desktopFile = plan.files.find((file) =>
    file.path.endsWith("/val-openai-bridge.desktop"),
  );
  const launcher = plan.files.find((file) =>
    file.path.endsWith("/launch-val-bridge"),
  );

  assert.equal(
    desktopFile?.path,
    "/home/friend/.data/applications/val-openai-bridge.desktop",
  );
  assert.match(
    desktopFile?.contents ?? "",
    /MimeType=x-scheme-handler\/val-openai-bridge;/,
  );
  assert.match(desktopFile?.contents ?? "", /Exec=.* %u/);
  assert.match(desktopFile?.contents ?? "", /Terminal=true/);
  assert.doesNotMatch(launcher?.contents ?? "", /\$@|\$1/);
  assert.deepEqual(plan.commands[0], {
    file: "xdg-mime",
    arguments: [
      "default",
      "val-openai-bridge.desktop",
      "x-scheme-handler/val-openai-bridge",
    ],
  });
});
