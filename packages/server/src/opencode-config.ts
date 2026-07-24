import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ValModel } from "@val-bridge/protocol";
import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";

const PROVIDER_ID = "val";
const REASONING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const REASONING_LEVEL_SET = new Set<string>(REASONING_LEVELS);
const GPT_56_DEFAULT_REASONING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const GPT_56_CONTEXT_TOKENS = 1_050_000;
const GPT_56_OUTPUT_TOKENS = 128_000;
const GPT_56_MODEL_PATTERN = /(?:^|[-_:/])gpt[-_]?5\.6(?:[-_:/]|$)/i;

type JsonRecord = Record<string, unknown>;

export type ConfigureOpenCodeOptions = {
  baseURL: string;
  clientApiKey: string;
  models: ValModel[];
  configPath?: string;
  now?: Date;
};

export type ConfigureOpenCodeResult = {
  providerId: typeof PROVIDER_ID;
  configPath: string;
  backupPath?: string;
  modelsConfigured: number;
  updated: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveOpenCodeConfigPath() {
  const configured = process.env.OPENCODE_CONFIG?.trim();
  if (configured) {
    return resolve(configured);
  }

  const configuredRoot = process.env.XDG_CONFIG_HOME?.trim();
  const configRoot = configuredRoot
    ? isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(configuredRoot)
    : join(homedir(), ".config");
  const directory = join(configRoot, "opencode");
  const jsoncPath = join(directory, "opencode.jsonc");
  const jsonPath = join(directory, "opencode.json");
  if (await exists(jsoncPath)) return jsoncPath;
  if (await exists(jsonPath)) return jsonPath;
  return jsoncPath;
}

function displayName(model: ValModel) {
  if (typeof model.name === "string" && model.name.trim()) {
    return model.name.trim();
  }
  return model.id
    .replace(/^openai-/i, "")
    .split("-")
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^\d+(?:\.\d+)*$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function collectReasoningLevels(
  value: unknown,
  path: string[] = [],
  levels = new Set<string>(),
  depth = 0,
) {
  if (depth > 8 || value === null || value === undefined) return levels;
  const relevantPath = path.some((part) => /reason|think|effort/i.test(part));
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (relevantPath && REASONING_LEVEL_SET.has(normalized)) {
      levels.add(normalized);
    }
    return levels;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReasoningLevels(item, path, levels, depth + 1);
    }
    return levels;
  }
  if (!isRecord(value)) return levels;
  for (const [key, nested] of Object.entries(value)) {
    collectReasoningLevels(nested, [...path, key], levels, depth + 1);
  }
  return levels;
}

export function reasoningLevelsForModel(model: ValModel) {
  const levels = collectReasoningLevels(model);
  if (isOpenAIGpt56Model(model)) {
    if (levels.size === 0) {
      for (const level of GPT_56_DEFAULT_REASONING_LEVELS) levels.add(level);
    }
    levels.add("max");
  }
  return REASONING_LEVELS.filter((level) => levels.has(level));
}

export function isOpenAIGpt56Model(model: ValModel) {
  return GPT_56_MODEL_PATTERN.test(model.id);
}

function modelFamily(model: ValModel) {
  const match = model.id.match(/gpt[-_]?(\d+(?:\.\d+)?)/i);
  return match?.[1] ? `gpt-${match[1]}` : undefined;
}

function reasoningVariant(level: (typeof REASONING_LEVELS)[number]) {
  return {
    reasoningEffort: level,
    reasoningSummary: "auto",
    ...(level === "max" ? { include: ["reasoning.encrypted_content"] } : {}),
  };
}

export function openCodeModel(model: ValModel) {
  const reasoningLevels = reasoningLevelsForModel(model);
  const family = modelFamily(model);
  const isGpt56 = isOpenAIGpt56Model(model);
  return {
    name: displayName(model),
    ...(family ? { family } : {}),
    ...(isGpt56
      ? {
          limit: {
            context: GPT_56_CONTEXT_TOKENS,
            output: GPT_56_OUTPUT_TOKENS,
          },
        }
      : {}),
    ...(reasoningLevels.length > 0
      ? {
          reasoning: true,
          variants: Object.fromEntries(
            reasoningLevels.map((level) => [level, reasoningVariant(level)]),
          ),
        }
      : {}),
    temperature: true,
    tool_call: true,
    attachment: true,
    modalities: {
      input: ["text", "image"],
      output: ["text"],
    },
  };
}

function formattingOptions(source: string): FormattingOptions {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indentation = source.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  return {
    insertSpaces: !indentation.includes("\t"),
    tabSize: indentation.includes("\t") ? 1 : indentation.length,
    eol,
  };
}

function parseConfig(source: string, path: string) {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: true,
  });
  if (errors.length > 0 || (parsed !== undefined && !isRecord(parsed))) {
    throw new Error(
      `OpenCode config is not valid JSON/JSONC: ${path}. No changes were made.`,
    );
  }
  return isRecord(parsed) ? parsed : {};
}

async function writeTextAtomic(path: string, contents: string, mode?: number) {
  const temporary = `${path}.${randomUUID().replaceAll("-", "")}.tmp`;
  await writeFile(temporary, contents, {
    encoding: "utf8",
    ...(mode === undefined ? {} : { mode }),
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function backupTimestamp(now: Date) {
  return now.toISOString().replace(/[-:.]/g, "");
}

export async function configureOpenCode(
  options: ConfigureOpenCodeOptions,
): Promise<ConfigureOpenCodeResult> {
  if (!options.baseURL.startsWith("http://127.0.0.1:")) {
    throw new Error("OpenCode can only be configured for the loopback bridge.");
  }
  if (!options.clientApiKey.startsWith("val-local-")) {
    throw new Error("The companion client API key is invalid.");
  }
  const modelsToConfigure = options.models.filter(isOpenAIGpt56Model);
  if (modelsToConfigure.length === 0) {
    throw new Error(
      "Val did not report any OpenAI GPT-5.6 models to configure.",
    );
  }

  const configPath = resolve(
    options.configPath ?? (await resolveOpenCodeConfigPath()),
  );
  const configExists = await exists(configPath);
  const rawSource = configExists
    ? await readFile(configPath, "utf8")
    : "{\n}\n";
  const source = rawSource.replace(/^\uFEFF/, "");
  const parsed = parseConfig(source, configPath);
  const provider = recordOrEmpty(parsed.provider);
  const existingVal = recordOrEmpty(provider[PROVIDER_ID]);
  const existingOptions = recordOrEmpty(existingVal.options);
  const existingModels = recordOrEmpty(existingVal.models);
  const generatedModels = Object.fromEntries(
    modelsToConfigure.map((model) => [
      model.id,
      {
        ...recordOrEmpty(existingModels[model.id]),
        ...openCodeModel(model),
      },
    ]),
  );
  const nextProvider = {
    ...existingVal,
    npm: "@ai-sdk/openai",
    name: "Val (RMIT Local Bridge)",
    options: {
      ...existingOptions,
      baseURL: options.baseURL,
      apiKey: options.clientApiKey,
      timeout: 300_000,
      headerTimeout: 30_000,
      chunkTimeout: 300_000,
    },
    models: generatedModels,
  };

  const format = formattingOptions(source);
  let nextSource = source;
  if (typeof parsed.$schema !== "string") {
    nextSource = applyEdits(
      nextSource,
      modify(nextSource, ["$schema"], "https://opencode.ai/config.json", {
        formattingOptions: format,
      }),
    );
  }
  nextSource = applyEdits(
    nextSource,
    modify(nextSource, ["provider", PROVIDER_ID], nextProvider, {
      formattingOptions: format,
    }),
  );
  const eol = format.eol ?? "\n";
  if (!nextSource.endsWith(eol)) nextSource += eol;

  if (nextSource === source) {
    return {
      providerId: PROVIDER_ID,
      configPath,
      modelsConfigured: modelsToConfigure.length,
      updated: false,
    };
  }

  await mkdir(dirname(configPath), { recursive: true });
  let backupPath: string | undefined;
  let mode: number | undefined;
  if (configExists) {
    const details = await stat(configPath);
    mode = details.mode;
    backupPath = `${configPath}.val-bridge-backup-${backupTimestamp(
      options.now ?? new Date(),
    )}`;
    await copyFile(configPath, backupPath);
  }
  await writeTextAtomic(configPath, nextSource, mode);

  return {
    providerId: PROVIDER_ID,
    configPath,
    ...(backupPath ? { backupPath } : {}),
    modelsConfigured: modelsToConfigure.length,
    updated: true,
  };
}
