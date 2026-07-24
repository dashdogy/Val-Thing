import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  UsageReasoningStatus,
  UsageStatsSnapshot,
} from "@val-bridge/protocol";
import { writeJsonAtomic } from "./json-file.js";

type UsageStatsFile = {
  version: 1;
  stats: UsageStatsSnapshot;
};

const REQUIRED_COUNTERS = [
  "startedAt",
  "lastUpdatedAt",
  "requests",
  "completedRequests",
  "failedRequests",
  "cancelledRequests",
  "meteredRequests",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "reasoningMeteredRequests",
  "reasoningSummaryRequests",
  "hiddenReasoningRequests",
  "pricedRequests",
  "estimatedOpenAICostNanodollars",
] as const satisfies readonly (keyof UsageStatsSnapshot)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeCounter(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function reasoningStatus(value: unknown): UsageReasoningStatus | undefined {
  return value === "summary" || value === "hidden" || value === "unavailable"
    ? value
    : undefined;
}

export function normalizeUsageStatsSnapshot(
  value: unknown,
): UsageStatsSnapshot | null {
  if (!isRecord(value)) return null;

  const counters = new Map<keyof UsageStatsSnapshot, number>();
  for (const key of REQUIRED_COUNTERS) {
    const counter = safeCounter(value[key]);
    if (counter === null) return null;
    counters.set(key, counter);
  }

  const snapshot: UsageStatsSnapshot = {
    startedAt: counters.get("startedAt")!,
    lastUpdatedAt: counters.get("lastUpdatedAt")!,
    requests: counters.get("requests")!,
    completedRequests: counters.get("completedRequests")!,
    failedRequests: counters.get("failedRequests")!,
    cancelledRequests: counters.get("cancelledRequests")!,
    meteredRequests: counters.get("meteredRequests")!,
    inputTokens: counters.get("inputTokens")!,
    outputTokens: counters.get("outputTokens")!,
    totalTokens: counters.get("totalTokens")!,
    reasoningTokens: counters.get("reasoningTokens")!,
    reasoningMeteredRequests: counters.get("reasoningMeteredRequests")!,
    reasoningSummaryRequests: counters.get("reasoningSummaryRequests")!,
    hiddenReasoningRequests: counters.get("hiddenReasoningRequests")!,
    pricedRequests: counters.get("pricedRequests")!,
    estimatedOpenAICostNanodollars: counters.get(
      "estimatedOpenAICostNanodollars",
    )!,
  };

  if (
    snapshot.completedRequests +
      snapshot.failedRequests +
      snapshot.cancelledRequests >
      snapshot.requests ||
    snapshot.meteredRequests > snapshot.requests ||
    snapshot.reasoningMeteredRequests > snapshot.requests ||
    snapshot.pricedRequests > snapshot.meteredRequests ||
    snapshot.reasoningSummaryRequests + snapshot.hiddenReasoningRequests >
      snapshot.completedRequests
  ) {
    return null;
  }

  for (const key of ["lastRequestTokens", "lastReasoningTokens"] as const) {
    if (!(key in value)) continue;
    const counter = safeCounter(value[key]);
    if (counter === null) return null;
    snapshot[key] = counter;
  }

  if ("lastReasoningTokensReported" in value) {
    if (typeof value.lastReasoningTokensReported !== "boolean") return null;
    snapshot.lastReasoningTokensReported = value.lastReasoningTokensReported;
  }

  if ("lastReasoningStatus" in value) {
    const status = reasoningStatus(value.lastReasoningStatus);
    if (!status) return null;
    snapshot.lastReasoningStatus = status;
  }

  return snapshot;
}

function progress(snapshot: UsageStatsSnapshot) {
  return (
    snapshot.requests +
    snapshot.completedRequests +
    snapshot.failedRequests +
    snapshot.cancelledRequests +
    snapshot.meteredRequests +
    snapshot.totalTokens
  );
}

function shouldReplace(
  current: UsageStatsSnapshot | undefined,
  incoming: UsageStatsSnapshot,
) {
  if (!current) return true;
  if (current.requests > 0 && incoming.requests === 0) return false;
  if (current.requests === 0 && incoming.requests > 0) return true;
  if (incoming.lastUpdatedAt !== current.lastUpdatedAt) {
    return incoming.lastUpdatedAt > current.lastUpdatedAt;
  }
  return progress(incoming) >= progress(current);
}

export class UsageStatsStore {
  private current?: UsageStatsSnapshot;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastWrite: Promise<void> = Promise.resolve();

  private constructor(readonly path: string) {}

  static async open(configDirectory: string) {
    const store = new UsageStatsStore(
      join(configDirectory, "usage-stats.json"),
    );
    try {
      const file = JSON.parse(
        await readFile(store.path, "utf8"),
      ) as Partial<UsageStatsFile>;
      if (file.version === 1) {
        store.current = normalizeUsageStatsSnapshot(file.stats) ?? undefined;
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
    }
    return store;
  }

  snapshot() {
    return this.current ? { ...this.current } : undefined;
  }

  update(value: unknown) {
    const snapshot = normalizeUsageStatsSnapshot(value);
    if (!snapshot) return false;
    if (!shouldReplace(this.current, snapshot)) return true;

    this.current = snapshot;
    const file: UsageStatsFile = { version: 1, stats: snapshot };
    const write = this.writeQueue.then(() => writeJsonAtomic(this.path, file));
    this.lastWrite = write;
    this.writeQueue = write.catch(() => undefined);
    void write.catch(() => undefined);
    return true;
  }

  async flush() {
    await this.lastWrite;
  }
}
