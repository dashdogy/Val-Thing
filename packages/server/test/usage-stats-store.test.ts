import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { UsageStatsSnapshot } from "@val-bridge/protocol";
import { UsageStatsStore } from "../src/usage-stats-store.js";

function usageStats(
  patch: Partial<UsageStatsSnapshot> = {},
): UsageStatsSnapshot {
  return {
    startedAt: 100,
    lastUpdatedAt: 200,
    requests: 2,
    completedRequests: 2,
    failedRequests: 0,
    cancelledRequests: 0,
    meteredRequests: 2,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    reasoningTokens: 3,
    reasoningMeteredRequests: 2,
    reasoningSummaryRequests: 1,
    hiddenReasoningRequests: 1,
    pricedRequests: 2,
    estimatedOpenAICostNanodollars: 1_000,
    lastRequestTokens: 8,
    lastReasoningTokens: 2,
    lastReasoningTokensReported: true,
    lastReasoningStatus: "summary",
    ...patch,
  };
}

test("persists only sanitized usage counters and restores them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "val-bridge-usage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = await UsageStatsStore.open(directory);
  const snapshot = usageStats();
  assert.equal(
    store.update({
      ...snapshot,
      messages: ["do not persist"],
      model: "private-model",
    }),
    true,
  );
  await store.flush();

  const persisted = await readFile(join(directory, "usage-stats.json"), "utf8");
  assert.ok(!persisted.includes("do not persist"));
  assert.ok(!persisted.includes("private-model"));

  const reopened = await UsageStatsStore.open(directory);
  assert.deepEqual(reopened.snapshot(), snapshot);
});

test("rejects malformed updates and preserves newer non-empty totals", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "val-bridge-usage-order-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = await UsageStatsStore.open(directory);
  const current = usageStats();
  assert.equal(store.update(current), true);
  assert.equal(
    store.update(usageStats({ lastUpdatedAt: 150, totalTokens: 30 })),
    true,
  );
  assert.equal(
    store.update({
      ...usageStats(),
      requests: "many",
    }),
    false,
  );
  assert.equal(
    store.update(
      usageStats({
        lastUpdatedAt: 1_000,
        requests: 0,
        completedRequests: 0,
        meteredRequests: 0,
        reasoningMeteredRequests: 0,
        reasoningSummaryRequests: 0,
        hiddenReasoningRequests: 0,
        pricedRequests: 0,
      }),
    ),
    true,
  );
  await store.flush();

  assert.deepEqual(store.snapshot(), current);
});

test("resets durable usage totals without allowing the old snapshot back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "val-bridge-usage-reset-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = await UsageStatsStore.open(directory);
  const previous = usageStats();
  assert.equal(store.update(previous), true);
  const reset = store.reset(1_000);
  await store.flush();
  assert.equal(reset.requests, 0);
  assert.equal(reset.totalTokens, 0);
  assert.equal(reset.startedAt, 1_000);

  assert.equal(store.update(previous), true);
  assert.deepEqual(store.snapshot(), reset);
  assert.deepEqual((await UsageStatsStore.open(directory)).snapshot(), reset);
});
