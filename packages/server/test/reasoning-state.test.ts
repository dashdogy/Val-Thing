import assert from "node:assert/strict";
import test from "node:test";
import {
  reasoningDisclosure,
  reasoningSettingsFromParameters,
  reasoningSettingsFromResponse,
  reasoningTokensFromUsage,
  usageTokenCounts,
} from "../src/reasoning-state.js";

test("normalizes token counts from Chat Completions and Responses usage", () => {
  assert.deepEqual(
    usageTokenCounts({
      prompt_tokens: 8,
      completion_tokens: 9,
      total_tokens: 17,
    }),
    { inputTokens: 8, outputTokens: 9, totalTokens: 17 },
  );
  assert.deepEqual(usageTokenCounts({ input_tokens: 4, output_tokens: 6 }), {
    inputTokens: 4,
    outputTokens: 6,
    totalTokens: 10,
  });
  assert.equal(
    reasoningTokensFromUsage({
      completion_tokens_details: { reasoning_tokens: 7 },
    }),
    7,
  );
  assert.equal(
    reasoningTokensFromUsage({
      outputTokensDetails: { reasoningTokens: 5 },
    }),
    5,
  );
  assert.equal(reasoningTokensFromUsage({ completion_tokens: 2 }), null);
});

test("distinguishes disclosed, hidden, and unavailable reasoning", () => {
  assert.deepEqual(
    reasoningDisclosure(
      {
        output_tokens_details: { reasoning_tokens: 4 },
      },
      "A genuine summary.",
      { effort: "max", summary: "detailed" },
    ),
    {
      status: "summary",
      reasoning_tokens: 4,
      tokens_reported: true,
      summary_available: true,
      requested_effort: "max",
      requested_summary: "detailed",
    },
  );
  assert.equal(
    reasoningDisclosure(
      { completion_tokens_details: { reasoning_tokens: 4 } },
      "",
    ).status,
    "hidden",
  );
  assert.deepEqual(reasoningDisclosure({}, ""), {
    status: "unavailable",
    reasoning_tokens: 0,
    tokens_reported: false,
    summary_available: false,
  });
});

test("reads reasoning settings without retaining request content", () => {
  assert.deepEqual(
    reasoningSettingsFromParameters({
      reasoning_effort: "high",
      reasoning_summary: "auto",
      prompt: "must not be copied",
    }),
    { effort: "high", summary: "auto" },
  );
  assert.deepEqual(
    reasoningSettingsFromResponse({
      effort: "max",
      summary: "detailed",
      encrypted_content: "ignored",
    }),
    { effort: "max", summary: "detailed" },
  );
});
