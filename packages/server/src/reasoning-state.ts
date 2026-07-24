import type { JsonObject } from "@val-bridge/protocol";

export type ReasoningDisclosureStatus = "summary" | "hidden" | "unavailable";

export type ReasoningDisclosure = {
  status: ReasoningDisclosureStatus;
  reasoning_tokens: number;
  tokens_reported: boolean;
  summary_available: boolean;
  requested_effort?: string;
  requested_summary?: string;
};

export type UsageTokenCounts = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type ReasoningSettings = {
  effort?: string;
  summary?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function firstCount(
  source: Record<string, unknown> | undefined,
  keys: string[],
) {
  if (!source) return undefined;
  for (const key of keys) {
    const value = nonnegativeInteger(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function usageTokenCounts(value: unknown): UsageTokenCounts {
  const usage = record(value);
  const inputTokens =
    firstCount(usage, [
      "prompt_tokens",
      "input_tokens",
      "promptTokens",
      "inputTokens",
      "prompt_eval_count",
    ]) ?? 0;
  const outputTokens =
    firstCount(usage, [
      "completion_tokens",
      "output_tokens",
      "completionTokens",
      "outputTokens",
      "eval_count",
    ]) ?? 0;
  const reportedTotal = firstCount(usage, ["total_tokens", "totalTokens"]);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(
      reportedTotal ?? inputTokens + outputTokens,
      inputTokens + outputTokens,
    ),
  };
}

export function reasoningTokensFromUsage(value: unknown): number | null {
  const usage = record(value);
  const direct = firstCount(usage, ["reasoning_tokens", "reasoningTokens"]);
  if (direct !== undefined) return direct;

  for (const key of [
    "completion_tokens_details",
    "output_tokens_details",
    "completionTokensDetails",
    "outputTokensDetails",
  ]) {
    const nested = firstCount(record(usage?.[key]), [
      "reasoning_tokens",
      "reasoningTokens",
    ]);
    if (nested !== undefined) return nested;
  }
  return null;
}

export function reasoningSettingsFromParameters(
  parameters: JsonObject | Record<string, unknown> | undefined,
): ReasoningSettings {
  return {
    ...(typeof parameters?.reasoning_effort === "string"
      ? { effort: parameters.reasoning_effort }
      : {}),
    ...(typeof parameters?.reasoning_summary === "string"
      ? { summary: parameters.reasoning_summary }
      : {}),
  };
}

export function reasoningSettingsFromResponse(
  reasoning: unknown,
): ReasoningSettings {
  if (typeof reasoning === "string") return { effort: reasoning };
  const value = record(reasoning);
  if (!value) return {};
  return {
    ...(typeof value.effort === "string" ? { effort: value.effort } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
  };
}

export function reasoningDisclosure(
  usage: unknown,
  summaryText: string,
  settings: ReasoningSettings = {},
): ReasoningDisclosure {
  const reportedTokens = reasoningTokensFromUsage(usage);
  const summaryAvailable = Boolean(summaryText.trim());
  const status: ReasoningDisclosureStatus = summaryAvailable
    ? "summary"
    : (reportedTokens ?? 0) > 0
      ? "hidden"
      : "unavailable";
  return {
    status,
    reasoning_tokens: reportedTokens ?? 0,
    tokens_reported: reportedTokens !== null,
    summary_available: summaryAvailable,
    ...(settings.effort ? { requested_effort: settings.effort } : {}),
    ...(settings.summary ? { requested_summary: settings.summary } : {}),
  };
}
