import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionUsageStats,
  estimateOpenAICostNanodollars,
  recordUsageRequest,
  restoreSessionUsageStats,
  settleUsageRequest,
  usageCounts,
} from "../src/usage-stats.js";

test("normalizes OpenAI and Val token usage shapes", () => {
  assert.deepEqual(
    usageCounts({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    }),
    { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
  );
  assert.deepEqual(usageCounts({ input_tokens: 4, output_tokens: 6 }), {
    inputTokens: 4,
    outputTokens: 6,
    totalTokens: 10,
  });
  assert.deepEqual(usageCounts({ prompt_eval_count: 7, eval_count: 3 }), {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
  });
  assert.equal(usageCounts({ duration_ms: 10 }), null);
});

test("tracks metered requests and outcomes without storing content", () => {
  let stats = createSessionUsageStats(100);
  stats = recordUsageRequest(stats, 110);
  stats = settleUsageRequest(
    stats,
    {
      prompt_tokens: 9,
      completion_tokens: 4,
      total_tokens: 13,
    },
    "completed",
    120,
    "openai-gpt-5.6-sol",
  );
  stats = recordUsageRequest(stats, 130);
  stats = settleUsageRequest(stats, undefined, "cancelled", 140);

  assert.deepEqual(stats, {
    startedAt: 100,
    lastUpdatedAt: 140,
    requests: 2,
    completedRequests: 1,
    failedRequests: 0,
    cancelledRequests: 1,
    meteredRequests: 1,
    inputTokens: 9,
    outputTokens: 4,
    totalTokens: 13,
    pricedRequests: 1,
    estimatedOpenAICostNanodollars: 165_000,
    lastRequestTokens: 13,
  });
  assert.ok(!("messages" in stats));
  assert.ok(!("model" in stats));
});

test("estimates current GPT-5.6 API-equivalent token costs", () => {
  assert.equal(
    estimateOpenAICostNanodollars("openai-gpt-5.6-sol", {
      prompt_tokens: 9,
      completion_tokens: 4,
    }),
    165_000,
  );
  assert.equal(
    estimateOpenAICostNanodollars("openai-gpt-5.6-terra", {
      input_tokens: 100,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 40 },
    }),
    310_000,
  );
  assert.equal(
    estimateOpenAICostNanodollars("openai-gpt-5.6-luna", {
      input_tokens: 272_001,
      output_tokens: 2,
    }),
    544_020_000,
  );
  assert.equal(
    estimateOpenAICostNanodollars("plain-model", {
      input_tokens: 10,
      output_tokens: 10,
    }),
    null,
  );
});

test("rejects malformed persisted counters", () => {
  const restored = restoreSessionUsageStats(
    {
      startedAt: -1,
      requests: "many",
      totalTokens: Number.POSITIVE_INFINITY,
    },
    500,
  );
  assert.deepEqual(restored, createSessionUsageStats(500));
});
