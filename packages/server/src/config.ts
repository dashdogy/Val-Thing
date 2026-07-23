import { randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "./json-file.js";

export type BridgeSecrets = {
  clientApiKey: string;
  bridgeSecret: string;
  extensionId?: string;
};

export type RuntimeConfig = {
  host: "127.0.0.1";
  port: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  bodyLimitBytes: number;
  corsOrigins: Set<string>;
  configDirectory: string;
};

function integerFromEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function defaultConfigDirectory() {
  if (process.env.VAL_BRIDGE_CONFIG_DIR) {
    return process.env.VAL_BRIDGE_CONFIG_DIR;
  }
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData
    ? join(localAppData, "ValOpenAIBridge")
    : join(homedir(), ".val-openai-bridge");
}

export function loadRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  const requestedHost =
    process.env.VAL_BRIDGE_HOST ?? overrides.host ?? "127.0.0.1";
  if (requestedHost !== "127.0.0.1") {
    throw new Error(
      "VAL_BRIDGE_HOST must be 127.0.0.1; non-loopback binding is not supported.",
    );
  }

  const configuredOrigins =
    process.env.VAL_BRIDGE_CORS_ORIGINS?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];

  return {
    host: "127.0.0.1",
    port: overrides.port ?? integerFromEnv("VAL_BRIDGE_PORT", 8787, 1, 65535),
    maxConcurrency:
      overrides.maxConcurrency ??
      integerFromEnv("VAL_BRIDGE_MAX_CONCURRENCY", 4, 1, 32),
    requestTimeoutMs:
      overrides.requestTimeoutMs ??
      integerFromEnv("VAL_BRIDGE_REQUEST_TIMEOUT_MS", 300_000, 1_000, 300_000),
    bodyLimitBytes: overrides.bodyLimitBytes ?? 10 * 1024 * 1024,
    corsOrigins: overrides.corsOrigins ?? new Set(configuredOrigins),
    configDirectory: overrides.configDirectory ?? defaultConfigDirectory(),
  };
}

function createSecrets(): BridgeSecrets {
  return {
    clientApiKey: `val-local-${randomBytes(32).toString("base64url")}`,
    bridgeSecret: randomBytes(32).toString("base64url"),
  };
}

export class SecretsStore {
  readonly path: string;
  private value: BridgeSecrets;

  private constructor(path: string, value: BridgeSecrets) {
    this.path = path;
    this.value = value;
  }

  static async open(configDirectory: string) {
    const path = join(configDirectory, "config.json");
    try {
      const parsed = JSON.parse(
        await readFile(path, "utf8"),
      ) as Partial<BridgeSecrets>;
      if (
        typeof parsed.clientApiKey !== "string" ||
        typeof parsed.bridgeSecret !== "string"
      ) {
        throw new Error(
          "The bridge configuration is missing required secrets.",
        );
      }
      return new SecretsStore(path, {
        clientApiKey: parsed.clientApiKey,
        bridgeSecret: parsed.bridgeSecret,
        ...(typeof parsed.extensionId === "string"
          ? { extensionId: parsed.extensionId }
          : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const value = createSecrets();
      await writeJsonAtomic(path, value);
      return new SecretsStore(path, value);
    }
  }

  get() {
    return { ...this.value };
  }

  async authorizeExtension(extensionId: string) {
    this.value = { ...this.value, extensionId };
    await writeJsonAtomic(this.path, this.value);
  }
}

export function createPairingCode() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
