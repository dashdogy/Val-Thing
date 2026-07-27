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
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const REASONING_LEVEL_SET = new Set<string>(REASONING_LEVELS);
const REASONING_SUMMARY_MODES = ["auto", "concise", "detailed"] as const;
const REASONING_SUMMARY_MODE_SET = new Set<string>(REASONING_SUMMARY_MODES);
const REASONING_MODES = ["standard", "pro"] as const;
const REASONING_MODE_SET = new Set<string>(REASONING_MODES);
const GPT_56_DEFAULT_REASONING_LEVELS = [
  "none",
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
type CapabilitySource =
  | "val_metadata"
  | "gpt_5_6_family"
  | "val_metadata_and_gpt_5_6_family"
  | "none";

export type ReasoningCapabilities = {
  levels: Array<(typeof REASONING_LEVELS)[number]>;
  summaryModes: Array<(typeof REASONING_SUMMARY_MODES)[number]>;
  modes: Array<(typeof REASONING_MODES)[number]>;
  effortSource: CapabilitySource;
  summarySource: CapabilitySource;
  modeSource: CapabilitySource;
};

export type ModelTokenLimits = {
  context?: number;
  output?: number;
  contextSource: "val_metadata" | "gpt_5_6_family" | "none";
  outputSource: "val_metadata" | "gpt_5_6_family" | "none";
};

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

function collectReasoningSummaryModes(
  value: unknown,
  path: string[] = [],
  modes = new Set<string>(),
  depth = 0,
) {
  if (depth > 8 || value === null || value === undefined) return modes;
  const joinedPath = path.join(".");
  const relevantPath =
    /(?:reason|think)/i.test(joinedPath) && /summary/i.test(joinedPath);
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (relevantPath && REASONING_SUMMARY_MODE_SET.has(normalized)) {
      modes.add(normalized);
    }
    return modes;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReasoningSummaryModes(item, path, modes, depth + 1);
    }
    return modes;
  }
  if (!isRecord(value)) return modes;
  for (const [key, nested] of Object.entries(value)) {
    collectReasoningSummaryModes(nested, [...path, key], modes, depth + 1);
  }
  return modes;
}

function collectReasoningModes(
  value: unknown,
  path: string[] = [],
  modes = new Set<string>(),
  depth = 0,
) {
  if (depth > 8 || value === null || value === undefined) return modes;
  const joinedPath = path.join(".");
  const relevantPath =
    /(?:reason|think)/i.test(joinedPath) && /mode/i.test(joinedPath);
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (relevantPath && REASONING_MODE_SET.has(normalized)) {
      modes.add(normalized);
    }
    return modes;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReasoningModes(item, path, modes, depth + 1);
    }
    return modes;
  }
  if (!isRecord(value)) return modes;
  for (const [key, nested] of Object.entries(value)) {
    collectReasoningModes(nested, [...path, key], modes, depth + 1);
  }
  return modes;
}

function hasCapabilityPath(
  value: unknown,
  expression: RegExp,
  path: string[] = [],
  depth = 0,
): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (expression.test(path.join("."))) return true;
  if (Array.isArray(value)) {
    return value.some((item) =>
      hasCapabilityPath(item, expression, path, depth + 1),
    );
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    hasCapabilityPath(nested, expression, [...path, key], depth + 1),
  );
}

function explicitCapabilityFlag(
  value: unknown,
  kind: "reasoning" | "summary",
  path: string[] = [],
  depth = 0,
): boolean | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  const joinedPath = path.join(".");
  if (typeof value === "boolean") {
    const reasoningPath = /(?:reason|think)/i.test(joinedPath);
    const summaryPath = /summary/i.test(joinedPath);
    const capabilityPath =
      /(?:support|enable|available|capabilit|reasoning|thinking)/i.test(
        joinedPath,
      ) && !/disabled/i.test(joinedPath);
    if (
      reasoningPath &&
      capabilityPath &&
      (kind === "summary" ? summaryPath : !summaryPath)
    ) {
      return value;
    }
    return undefined;
  }
  const children = Array.isArray(value)
    ? value.map((nested, index) => [String(index), nested] as const)
    : isRecord(value)
      ? Object.entries(value)
      : [];
  let enabled: boolean | undefined;
  for (const [key, nested] of children) {
    const result = explicitCapabilityFlag(
      nested,
      kind,
      [...path, key],
      depth + 1,
    );
    if (result === false) return false;
    if (result === true) enabled = true;
  }
  return enabled;
}

export function reasoningCapabilitiesForModel(
  model: ValModel,
): ReasoningCapabilities {
  const levels = collectReasoningLevels(model);
  const summaryModes = collectReasoningSummaryModes(model);
  const modes = collectReasoningModes(model);
  const isGpt56 = isOpenAIGpt56Model(model);
  const effortFlag = explicitCapabilityFlag(model, "reasoning");
  const summaryFlag = explicitCapabilityFlag(model, "summary");
  const hasEffortMetadata =
    levels.size > 0 ||
    hasCapabilityPath(model, /(?:reason|think).*(?:effort|level)/i);
  const hasSummaryMetadata =
    summaryModes.size > 0 ||
    hasCapabilityPath(model, /(?:reason|think).*summary/i);
  const hasModeMetadata =
    modes.size > 0 || hasCapabilityPath(model, /(?:reason|think).*mode/i);

  let effortSource: CapabilitySource = "none";
  if (effortFlag !== false) {
    if (hasEffortMetadata) {
      effortSource = "val_metadata";
      if (isGpt56 && !levels.has("max")) {
        levels.add("max");
        effortSource = "val_metadata_and_gpt_5_6_family";
      }
    } else if (isGpt56) {
      for (const level of GPT_56_DEFAULT_REASONING_LEVELS) levels.add(level);
      effortSource = "gpt_5_6_family";
    }
  }
  if (effortFlag === false) levels.clear();

  let summarySource: CapabilitySource = "none";
  if (summaryFlag !== false) {
    if (hasSummaryMetadata) {
      summarySource = "val_metadata";
    } else if (isGpt56 && levels.size > 0) {
      summaryModes.add("auto");
      summaryModes.add("detailed");
      summarySource = "gpt_5_6_family";
    }
  }
  if (summaryFlag === false) summaryModes.clear();

  let modeSource: CapabilitySource = "none";
  if (effortFlag !== false) {
    if (hasModeMetadata) {
      modeSource = "val_metadata";
    }
    if (isGpt56 && !modes.has("standard")) {
      modes.add("standard");
      modeSource =
        modeSource === "val_metadata"
          ? "val_metadata_and_gpt_5_6_family"
          : "gpt_5_6_family";
    }
  }
  if (effortFlag === false) modes.clear();

  return {
    levels: REASONING_LEVELS.filter((level) => levels.has(level)),
    summaryModes: REASONING_SUMMARY_MODES.filter((mode) =>
      summaryModes.has(mode),
    ),
    modes: REASONING_MODES.filter((mode) => modes.has(mode)),
    effortSource,
    summarySource,
    modeSource,
  };
}

export function reasoningLevelsForModel(model: ValModel) {
  return reasoningCapabilitiesForModel(model).levels;
}

export function isOpenAIGpt56Model(model: ValModel) {
  return GPT_56_MODEL_PATTERN.test(model.id);
}

const CONTEXT_LIMIT_KEYS = new Set([
  "contextlength",
  "contextlimit",
  "contexttokens",
  "contextwindow",
  "maxcontextlength",
  "maxcontexttokens",
  "maxcontextwindow",
]);
const OUTPUT_LIMIT_KEYS = new Set([
  "completiontokenlimit",
  "maxcompletiontokens",
  "maxoutputtokens",
  "outputtokenlimit",
  "outputtokens",
]);

function tokenLimit(value: unknown) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 && numeric <= 10_000_000
    ? numeric
    : undefined;
}

function collectTokenLimits(
  value: unknown,
  limits: { context: number[]; output: number[] },
  path: string[] = [],
  depth = 0,
) {
  if (depth > 8 || value === null || value === undefined) return;
  const entries = Array.isArray(value)
    ? value.map((nested, index) => [String(index), nested] as const)
    : isRecord(value)
      ? Object.entries(value)
      : [];
  for (const [key, nested] of entries) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const parentPath = path.join(".").toLowerCase();
    const numeric = tokenLimit(nested);
    const contextKey =
      CONTEXT_LIMIT_KEYS.has(normalizedKey) ||
      (normalizedKey === "context" &&
        /(?:limit|token|capabilit|model)/.test(parentPath));
    const outputKey =
      OUTPUT_LIMIT_KEYS.has(normalizedKey) ||
      (normalizedKey === "output" &&
        /(?:limit|token|capabilit|model)/.test(parentPath));
    if (numeric !== undefined && contextKey) limits.context.push(numeric);
    if (numeric !== undefined && outputKey) limits.output.push(numeric);
    collectTokenLimits(nested, limits, [...path, key], depth + 1);
  }
}

export function modelTokenLimits(model: ValModel): ModelTokenLimits {
  const candidates = { context: [] as number[], output: [] as number[] };
  collectTokenLimits(model, candidates);
  const metadataContext =
    candidates.context.length > 0 ? Math.max(...candidates.context) : undefined;
  const metadataOutput =
    candidates.output.length > 0 ? Math.max(...candidates.output) : undefined;
  const isGpt56 = isOpenAIGpt56Model(model);
  return {
    ...(metadataContext !== undefined
      ? { context: metadataContext }
      : isGpt56
        ? { context: GPT_56_CONTEXT_TOKENS }
        : {}),
    ...(metadataOutput !== undefined
      ? { output: metadataOutput }
      : isGpt56
        ? { output: GPT_56_OUTPUT_TOKENS }
        : {}),
    contextSource:
      metadataContext !== undefined
        ? "val_metadata"
        : isGpt56
          ? "gpt_5_6_family"
          : "none",
    outputSource:
      metadataOutput !== undefined
        ? "val_metadata"
        : isGpt56
          ? "gpt_5_6_family"
          : "none",
  };
}

function modelFamily(model: ValModel) {
  const match = model.id.match(/gpt[-_]?(\d+(?:\.\d+)?)/i);
  return match?.[1] ? `gpt-${match[1]}` : undefined;
}

function reasoningVariant(
  level: (typeof REASONING_LEVELS)[number],
  summarySupported: boolean,
  mode?: (typeof REASONING_MODES)[number],
) {
  return {
    reasoningEffort: level,
    ...(summarySupported && level !== "none"
      ? { reasoningSummary: "auto" }
      : level === "max"
        ? { reasoningSummary: "auto" }
        : {}),
    ...(level === "max" ? { include: ["reasoning.encrypted_content"] } : {}),
    ...(level === "none" ? {} : { reasoningContext: "all_turns" }),
    ...(mode ? { reasoningMode: mode } : {}),
  };
}

export function openCodeModel(model: ValModel) {
  const reasoningCapabilities = reasoningCapabilitiesForModel(model);
  const reasoningLevels = reasoningCapabilities.levels;
  const tokenLimits = modelTokenLimits(model);
  const family = modelFamily(model);
  const summarySupported =
    reasoningCapabilities.summaryModes.includes("auto") ||
    reasoningCapabilities.summaryModes.includes("detailed");
  const variants: Record<string, Record<string, unknown>> = {};
  for (const level of reasoningLevels) {
    variants[level] = reasoningVariant(level, summarySupported);
    if (reasoningCapabilities.modes.includes("pro")) {
      variants[`pro-${level}`] = reasoningVariant(
        level,
        summarySupported,
        "pro",
      );
    }
    if (
      level === "max" &&
      reasoningCapabilities.summaryModes.includes("detailed")
    ) {
      variants["max-detailed"] = {
        reasoningEffort: "max",
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        reasoningContext: "all_turns",
      };
    }
  }
  return {
    name: displayName(model),
    ...(family ? { family } : {}),
    ...(tokenLimits.context !== undefined || tokenLimits.output !== undefined
      ? {
          limit: {
            ...(tokenLimits.context !== undefined
              ? { context: tokenLimits.context }
              : {}),
            ...(tokenLimits.output !== undefined
              ? { output: tokenLimits.output }
              : {}),
          },
        }
      : {}),
    ...(reasoningLevels.length > 0
      ? {
          reasoning: true,
          variants,
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

export function openAIModelCapabilities(model: ValModel) {
  const reasoning = reasoningCapabilitiesForModel(model);
  const tokenLimits = modelTokenLimits(model);
  return {
    ...(tokenLimits.context !== undefined
      ? { context_window: tokenLimits.context }
      : {}),
    ...(tokenLimits.output !== undefined
      ? { max_output_tokens: tokenLimits.output }
      : {}),
    val_capabilities: {
      reasoning: reasoning.levels.length > 0,
      reasoning_efforts: reasoning.levels,
      reasoning_summaries: reasoning.summaryModes,
      reasoning_modes: reasoning.modes,
      token_limits: {
        context: tokenLimits.contextSource,
        output: tokenLimits.outputSource,
      },
      evidence: {
        effort: reasoning.effortSource,
        summary: reasoning.summarySource,
        mode: reasoning.modeSource,
      },
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
