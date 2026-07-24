export type UsageOutcome = "completed" | "failed" | "cancelled";
export type ReasoningAvailability = "summary" | "hidden" | "unavailable";

export type SessionUsageStats = {
  startedAt: number;
  lastUpdatedAt: number;
  requests: number;
  completedRequests: number;
  failedRequests: number;
  cancelledRequests: number;
  meteredRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  reasoningMeteredRequests: number;
  reasoningSummaryRequests: number;
  hiddenReasoningRequests: number;
  pricedRequests: number;
  estimatedOpenAICostNanodollars: number;
  lastRequestTokens?: number;
  lastReasoningTokens?: number;
  lastReasoningTokensReported?: boolean;
  lastReasoningStatus?: ReasoningAvailability;
};

type UsageCounts = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type Gpt56Tier = "sol" | "terra" | "luna";

const INPUT_TOKEN_KEYS = [
  "prompt_tokens",
  "input_tokens",
  "promptTokens",
  "inputTokens",
  "prompt_eval_count",
];
const OUTPUT_TOKEN_KEYS = [
  "completion_tokens",
  "output_tokens",
  "completionTokens",
  "outputTokens",
  "eval_count",
];
const TOKEN_DETAIL_KEYS = [
  "prompt_tokens_details",
  "input_tokens_details",
  "promptTokensDetails",
  "inputTokensDetails",
];
const REASONING_TOKEN_DETAIL_KEYS = [
  "completion_tokens_details",
  "output_tokens_details",
  "completionTokensDetails",
  "outputTokensDetails",
];
const LONG_CONTEXT_THRESHOLD = 272_000;
const GPT_56_PRICING_NANODOLLARS_PER_TOKEN: Record<
  Gpt56Tier,
  { input: number; cachedInput: number; output: number }
> = {
  sol: { input: 5_000, cachedInput: 500, output: 30_000 },
  terra: { input: 2_500, cachedInput: 250, output: 15_000 },
  luna: { input: 1_000, cachedInput: 100, output: 6_000 },
};

function count(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function responseUsageDetails(value: unknown) {
  const event = record(value);
  const response = record(event?.response) ?? event;
  const usage = record(response?.usage);
  const output = Array.isArray(response?.output) ? response.output : [];
  const reasoningSummaryAvailable = output.some((rawItem) => {
    const item = record(rawItem);
    if (item?.type !== "reasoning" || !Array.isArray(item.summary)) return false;
    return item.summary.some((rawPart) => {
      const part = record(rawPart);
      return typeof part?.text === "string" && part.text.trim().length > 0;
    });
  });
  return { usage, reasoningSummaryAvailable };
}

function storedCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function storedBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function storedReasoningStatus(
  value: unknown,
): ReasoningAvailability | undefined {
  return value === "summary" || value === "hidden" || value === "unavailable"
    ? value
    : undefined;
}

export function usageCounts(value: unknown): UsageCounts | null {
  const usage = record(value);
  if (!usage) return null;
  const inputTokens = count(usage, INPUT_TOKEN_KEYS);
  const outputTokens = count(usage, OUTPUT_TOKEN_KEYS);
  const reportedTotal = count(usage, ["total_tokens", "totalTokens"]);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reportedTotal === undefined
  ) {
    return null;
  }
  const knownInput = inputTokens ?? 0;
  const knownOutput = outputTokens ?? 0;
  return {
    inputTokens: knownInput,
    outputTokens: knownOutput,
    totalTokens: Math.max(
      reportedTotal ?? knownInput + knownOutput,
      knownInput + knownOutput,
    ),
  };
}

export function reasoningTokensFromUsage(value: unknown): number | null {
  const usage = record(value);
  if (!usage) return null;
  const direct = count(usage, ["reasoning_tokens", "reasoningTokens"]);
  if (direct !== undefined) return direct;
  for (const detailKey of REASONING_TOKEN_DETAIL_KEYS) {
    const details = record(usage[detailKey]);
    if (!details) continue;
    const reasoning = count(details, ["reasoning_tokens", "reasoningTokens"]);
    if (reasoning !== undefined) return reasoning;
  }
  return null;
}

function cachedInputTokens(usage: Record<string, unknown>) {
  for (const detailKey of TOKEN_DETAIL_KEYS) {
    const details = record(usage[detailKey]);
    if (!details) continue;
    const cached = count(details, ["cached_tokens", "cachedTokens"]);
    if (cached !== undefined) return cached;
  }
  return 0;
}

function gpt56Tier(model: string): Gpt56Tier | null {
  const normalized = model.toLowerCase();
  const family = normalized.match(/(?:^|[-_:/])gpt[-_]?5\.6(?=$|[-_:/])/);
  if (!family || family.index === undefined) return null;
  const suffix = normalized
    .slice(family.index + family[0].length)
    .replace(/^[-_:/]+/, "");
  if (!suffix) return "sol";
  const tier = suffix.split(/[-_:/]/, 1)[0];
  return tier === "sol" || tier === "terra" || tier === "luna" ? tier : null;
}

export function estimateOpenAICostNanodollars(
  model: string,
  value: unknown,
): number | null {
  const tier = gpt56Tier(model);
  const usage = record(value);
  if (!tier || !usage) return null;

  const inputTokens = count(usage, INPUT_TOKEN_KEYS);
  const outputTokens = count(usage, OUTPUT_TOKEN_KEYS);
  if (inputTokens === undefined || outputTokens === undefined) return null;

  const prices = GPT_56_PRICING_NANODOLLARS_PER_TOKEN[tier];
  const cachedTokens = Math.min(cachedInputTokens(usage), inputTokens);
  const uncachedTokens = inputTokens - cachedTokens;
  const longContext = inputTokens > LONG_CONTEXT_THRESHOLD;
  const inputCost =
    (uncachedTokens * prices.input + cachedTokens * prices.cachedInput) *
    (longContext ? 2 : 1);
  const outputCost = outputTokens * prices.output * (longContext ? 1.5 : 1);
  return Math.round(inputCost + outputCost);
}

export function createSessionUsageStats(now = Date.now()): SessionUsageStats {
  return {
    startedAt: now,
    lastUpdatedAt: now,
    requests: 0,
    completedRequests: 0,
    failedRequests: 0,
    cancelledRequests: 0,
    meteredRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    reasoningMeteredRequests: 0,
    reasoningSummaryRequests: 0,
    hiddenReasoningRequests: 0,
    pricedRequests: 0,
    estimatedOpenAICostNanodollars: 0,
  };
}

export function restoreSessionUsageStats(
  value: unknown,
  now = Date.now(),
): SessionUsageStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createSessionUsageStats(now);
  }
  const record = value as Record<string, unknown>;
  const startedAt = storedCount(record.startedAt) || now;
  const restored: SessionUsageStats = {
    startedAt,
    lastUpdatedAt: storedCount(record.lastUpdatedAt) || startedAt,
    requests: storedCount(record.requests),
    completedRequests: storedCount(record.completedRequests),
    failedRequests: storedCount(record.failedRequests),
    cancelledRequests: storedCount(record.cancelledRequests),
    meteredRequests: storedCount(record.meteredRequests),
    inputTokens: storedCount(record.inputTokens),
    outputTokens: storedCount(record.outputTokens),
    totalTokens: storedCount(record.totalTokens),
    reasoningTokens: storedCount(record.reasoningTokens),
    reasoningMeteredRequests: storedCount(record.reasoningMeteredRequests),
    reasoningSummaryRequests: storedCount(record.reasoningSummaryRequests),
    hiddenReasoningRequests: storedCount(record.hiddenReasoningRequests),
    pricedRequests: storedCount(record.pricedRequests),
    estimatedOpenAICostNanodollars: storedCount(
      record.estimatedOpenAICostNanodollars,
    ),
  };
  const lastRequestTokens = storedCount(record.lastRequestTokens);
  if (lastRequestTokens > 0) {
    restored.lastRequestTokens = lastRequestTokens;
  }
  const lastReasoningTokens = storedCount(record.lastReasoningTokens);
  const lastReasoningTokensReported = storedBoolean(
    record.lastReasoningTokensReported,
  );
  const lastReasoningStatus = storedReasoningStatus(record.lastReasoningStatus);
  if (lastReasoningTokensReported !== undefined) {
    restored.lastReasoningTokensReported = lastReasoningTokensReported;
    restored.lastReasoningTokens = lastReasoningTokens;
  }
  if (lastReasoningStatus) {
    restored.lastReasoningStatus = lastReasoningStatus;
  }
  return restored;
}

export function recordUsageRequest(
  stats: SessionUsageStats,
  now = Date.now(),
): SessionUsageStats {
  return {
    ...stats,
    requests: stats.requests + 1,
    lastUpdatedAt: now,
  };
}

export function settleUsageRequest(
  stats: SessionUsageStats,
  usage: unknown,
  outcome: UsageOutcome,
  now = Date.now(),
  model?: string,
  details: { reasoningSummaryAvailable?: boolean } = {},
): SessionUsageStats {
  const counts = usageCounts(usage);
  const reasoningTokens = reasoningTokensFromUsage(usage);
  const summaryAvailable = details.reasoningSummaryAvailable === true;
  const completedReasoningStatus: ReasoningAvailability = summaryAvailable
    ? "summary"
    : (reasoningTokens ?? 0) > 0
      ? "hidden"
      : "unavailable";
  const estimatedCost =
    typeof model === "string"
      ? estimateOpenAICostNanodollars(model, usage)
      : null;
  return {
    ...stats,
    lastUpdatedAt: now,
    completedRequests:
      stats.completedRequests + (outcome === "completed" ? 1 : 0),
    failedRequests: stats.failedRequests + (outcome === "failed" ? 1 : 0),
    cancelledRequests:
      stats.cancelledRequests + (outcome === "cancelled" ? 1 : 0),
    meteredRequests: stats.meteredRequests + (counts ? 1 : 0),
    inputTokens: stats.inputTokens + (counts?.inputTokens ?? 0),
    outputTokens: stats.outputTokens + (counts?.outputTokens ?? 0),
    totalTokens: stats.totalTokens + (counts?.totalTokens ?? 0),
    reasoningTokens: stats.reasoningTokens + (reasoningTokens ?? 0),
    reasoningMeteredRequests:
      stats.reasoningMeteredRequests + (reasoningTokens === null ? 0 : 1),
    reasoningSummaryRequests:
      stats.reasoningSummaryRequests +
      (outcome === "completed" && summaryAvailable ? 1 : 0),
    hiddenReasoningRequests:
      stats.hiddenReasoningRequests +
      (outcome === "completed" &&
      !summaryAvailable &&
      (reasoningTokens ?? 0) > 0
        ? 1
        : 0),
    pricedRequests: stats.pricedRequests + (estimatedCost === null ? 0 : 1),
    estimatedOpenAICostNanodollars:
      stats.estimatedOpenAICostNanodollars + (estimatedCost ?? 0),
    ...(counts ? { lastRequestTokens: counts.totalTokens } : {}),
    ...(outcome === "completed"
      ? {
          lastReasoningStatus: completedReasoningStatus,
          lastReasoningTokens: reasoningTokens ?? 0,
          lastReasoningTokensReported: reasoningTokens !== null,
        }
      : {}),
  };
}
