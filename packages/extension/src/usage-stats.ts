export type UsageOutcome = "completed" | "failed" | "cancelled";

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
  lastRequestTokens?: number;
};

type UsageCounts = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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

function storedCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export function usageCounts(value: unknown): UsageCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const inputTokens = count(record, [
    "prompt_tokens",
    "input_tokens",
    "promptTokens",
    "inputTokens",
    "prompt_eval_count",
  ]);
  const outputTokens = count(record, [
    "completion_tokens",
    "output_tokens",
    "completionTokens",
    "outputTokens",
    "eval_count",
  ]);
  const reportedTotal = count(record, ["total_tokens", "totalTokens"]);
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
  };
  const lastRequestTokens = storedCount(record.lastRequestTokens);
  if (lastRequestTokens > 0) {
    restored.lastRequestTokens = lastRequestTokens;
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
): SessionUsageStats {
  const counts = usageCounts(usage);
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
    ...(counts ? { lastRequestTokens: counts.totalTokens } : {}),
  };
}
