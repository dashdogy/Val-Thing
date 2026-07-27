export type PairingPageLaunchCommand = {
  file: string;
  arguments: string[];
};

export function pairingPageUrl(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The companion port is invalid.");
  }
  return `http://127.0.0.1:${port}/pairing`;
}

export function pairingPageLaunchCommand(
  platform: NodeJS.Platform,
  port: number,
): PairingPageLaunchCommand | undefined {
  if (platform !== "win32") return undefined;
  return {
    file: "rundll32.exe",
    arguments: ["url.dll,FileProtocolHandler", pairingPageUrl(port)],
  };
}
