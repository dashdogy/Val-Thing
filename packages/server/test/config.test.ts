import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config.js";

test("defaults to the maximum of 16 concurrent requests", () => {
  const original = process.env.VAL_BRIDGE_MAX_CONCURRENCY;
  try {
    delete process.env.VAL_BRIDGE_MAX_CONCURRENCY;
    assert.equal(loadRuntimeConfig().maxConcurrency, 16);

    process.env.VAL_BRIDGE_MAX_CONCURRENCY = "12";
    assert.equal(loadRuntimeConfig().maxConcurrency, 12);

    process.env.VAL_BRIDGE_MAX_CONCURRENCY = "17";
    assert.throws(
      () => loadRuntimeConfig(),
      /VAL_BRIDGE_MAX_CONCURRENCY must be an integer between 1 and 16/,
    );
  } finally {
    if (original === undefined) {
      delete process.env.VAL_BRIDGE_MAX_CONCURRENCY;
    } else {
      process.env.VAL_BRIDGE_MAX_CONCURRENCY = original;
    }
  }
});
