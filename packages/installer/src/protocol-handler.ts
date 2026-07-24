import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix } from "node:path";
import { promisify } from "node:util";
import { COMPANION_LAUNCH_URL } from "@val-bridge/protocol";

const execFileAsync = promisify(execFile);
const PROTOCOL_SCHEME = new URL(COMPANION_LAUNCH_URL).protocol.slice(0, -1);
const DESKTOP_FILE_NAME = "val-openai-bridge.desktop";

type RegistrationFile = {
  path: string;
  contents: string;
  mode: number;
};

type RegistrationCommand = {
  file: string;
  arguments: string[];
};

export type LaunchProtocolRegistrationPlan = {
  launchUrl: typeof COMPANION_LAUNCH_URL;
  files: RegistrationFile[];
  commands: RegistrationCommand[];
};

export type LaunchProtocolPlanOptions = {
  platform: NodeJS.Platform;
  installRoot: string;
  startPath: string;
  nodePath: string;
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
};

type RegisterLaunchProtocolOptions = {
  installRoot: string;
  startPath: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  logger?: Pick<Console, "log">;
  runCommand?: (file: string, arguments_: string[]) => Promise<unknown>;
};

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function desktopQuote(value: string) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")
    .replaceAll("%", "%%")}"`;
}

function windowsCommand(
  nodePath: string,
  startPath: string,
  installRoot: string,
) {
  if (
    nodePath.includes('"') ||
    startPath.includes('"') ||
    installRoot.includes('"')
  ) {
    throw new Error("The launch command paths cannot contain quotation marks.");
  }
  return `"${nodePath}" "${startPath}" --install-dir "${installRoot}" --launch-url "%1"`;
}

function macPlan(options: LaunchProtocolPlanOptions) {
  const path = posix;
  const applicationPath = path.join(
    options.installRoot,
    "Val Bridge Launcher.app",
  );
  const executableName = "val-bridge-launcher";
  const executablePath = path.join(
    applicationPath,
    "Contents",
    "MacOS",
    executableName,
  );
  const terminalLauncherPath = path.join(
    path.dirname(options.startPath),
    "Launch Val Bridge.command",
  );
  const terminalLauncher = `#!/bin/sh
exec ${shellQuote(options.nodePath)} ${shellQuote(options.startPath)} --install-dir ${shellQuote(options.installRoot)}
`;
  const applicationLauncher = `#!/bin/sh
exec /usr/bin/open -a Terminal ${shellQuote(terminalLauncherPath)}
`;
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Val Bridge Launcher</string>
  <key>CFBundleExecutable</key>
  <string>${xmlEscape(executableName)}</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.dashdogy.val-openai-bridge.launcher</string>
  <key>CFBundleName</key>
  <string>Val Bridge Launcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>io.github.dashdogy.val-openai-bridge.launch</string>
      <key>CFBundleTypeRole</key>
      <string>Shell</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${xmlEscape(PROTOCOL_SCHEME)}</string>
      </array>
    </dict>
  </array>
  <key>CFBundleVersion</key>
  <string>2</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.1</string>
</dict>
</plist>
`;
  return {
    files: [
      {
        path: terminalLauncherPath,
        contents: terminalLauncher,
        mode: 0o755,
      },
      {
        path: path.join(applicationPath, "Contents", "Info.plist"),
        contents: infoPlist,
        mode: 0o644,
      },
      { path: executablePath, contents: applicationLauncher, mode: 0o755 },
    ],
    commands: [
      {
        file: "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        arguments: ["-f", applicationPath],
      },
    ],
  };
}

function linuxPlan(options: LaunchProtocolPlanOptions) {
  const path = posix;
  const configuredDataHome = options.environment.XDG_DATA_HOME;
  const dataHome =
    configuredDataHome && path.isAbsolute(configuredDataHome)
      ? configuredDataHome
      : path.join(options.homeDirectory, ".local", "share");
  const launcherPath = path.join(
    path.dirname(options.startPath),
    "launch-val-bridge",
  );
  const desktopPath = path.join(dataHome, "applications", DESKTOP_FILE_NAME);
  const launcher = `#!/bin/sh
exec ${shellQuote(options.nodePath)} ${shellQuote(options.startPath)} --install-dir ${shellQuote(options.installRoot)}
`;
  const desktopFile = `[Desktop Entry]
Version=1.0
Type=Application
Name=Val Bridge Launcher
Comment=Launch the local Val OpenAI companion
Exec=${desktopQuote(launcherPath)} %u
Terminal=true
NoDisplay=true
StartupNotify=false
MimeType=x-scheme-handler/${PROTOCOL_SCHEME};
Categories=Development;
`;
  return {
    files: [
      { path: launcherPath, contents: launcher, mode: 0o755 },
      { path: desktopPath, contents: desktopFile, mode: 0o644 },
    ],
    commands: [
      {
        file: "xdg-mime",
        arguments: [
          "default",
          DESKTOP_FILE_NAME,
          `x-scheme-handler/${PROTOCOL_SCHEME}`,
        ],
      },
    ],
  };
}

function windowsPlan(options: LaunchProtocolPlanOptions) {
  const key = `HKCU\\Software\\Classes\\${PROTOCOL_SCHEME}`;
  return {
    files: [],
    commands: [
      {
        file: "reg.exe",
        arguments: ["ADD", key, "/ve", "/d", "URL:Val Bridge Launcher", "/f"],
      },
      {
        file: "reg.exe",
        arguments: ["ADD", key, "/v", "URL Protocol", "/d", "", "/f"],
      },
      {
        file: "reg.exe",
        arguments: [
          "ADD",
          `${key}\\shell\\open\\command`,
          "/ve",
          "/d",
          windowsCommand(
            options.nodePath,
            options.startPath,
            options.installRoot,
          ),
          "/f",
        ],
      },
    ],
  };
}

export function launchProtocolRegistrationPlan(
  options: LaunchProtocolPlanOptions,
): LaunchProtocolRegistrationPlan {
  const platformPlan =
    options.platform === "win32"
      ? windowsPlan(options)
      : options.platform === "darwin"
        ? macPlan(options)
        : linuxPlan(options);
  return {
    launchUrl: COMPANION_LAUNCH_URL,
    ...platformPlan,
  };
}

export async function registerCompanionLaunchProtocol(
  options: RegisterLaunchProtocolOptions,
) {
  const plan = launchProtocolRegistrationPlan({
    platform: options.platform ?? process.platform,
    installRoot: options.installRoot,
    startPath: options.startPath,
    nodePath: options.nodePath ?? process.execPath,
    environment: options.environment ?? process.env,
    homeDirectory: options.homeDirectory ?? homedir(),
  });
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, { encoding: "utf8" });
    await chmod(file.path, file.mode);
  }
  const runCommand =
    options.runCommand ??
    ((file: string, arguments_: string[]) =>
      execFileAsync(file, arguments_, { windowsHide: true }));
  for (const command of plan.commands) {
    await runCommand(command.file, command.arguments);
  }
  options.logger?.log(
    `Registered ${plan.launchUrl} for the extension launch button.`,
  );
  return plan;
}
