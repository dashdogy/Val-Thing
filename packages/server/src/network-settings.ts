import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./json-file.js";

export type NetworkScope = "loopback" | "lan";

type NetworkSettingsFile = {
  version: 1;
  scope: NetworkScope;
};

export function hostForNetworkScope(scope: NetworkScope) {
  return scope === "lan" ? ("0.0.0.0" as const) : ("127.0.0.1" as const);
}

export function networkScopeForHost(host: "0.0.0.0" | "127.0.0.1") {
  return host === "0.0.0.0" ? ("lan" as const) : ("loopback" as const);
}

export class NetworkSettingsStore {
  private scope?: NetworkScope;

  private constructor(readonly path: string) {}

  static async open(configDirectory: string) {
    const store = new NetworkSettingsStore(
      join(configDirectory, "network-settings.json"),
    );
    try {
      const parsed = JSON.parse(
        await readFile(store.path, "utf8"),
      ) as Partial<NetworkSettingsFile>;
      if (
        parsed.version !== 1 ||
        (parsed.scope !== "loopback" && parsed.scope !== "lan")
      ) {
        throw new Error("The bridge network settings are invalid.");
      }
      store.scope = parsed.scope;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  get() {
    return this.scope;
  }

  async set(scope: NetworkScope) {
    await writeJsonAtomic(this.path, { version: 1, scope });
    this.scope = scope;
  }
}
