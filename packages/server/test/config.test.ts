import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config.js";
import {
  clientIpAllowed,
  isLoopbackAddress,
  normalizeRemoteAddress,
} from "../src/server.js";

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

test("validates exact client IP allowlists while always allowing loopback", () => {
  const original = process.env.VAL_BRIDGE_ALLOWED_CLIENT_IPS;
  try {
    process.env.VAL_BRIDGE_ALLOWED_CLIENT_IPS = "192.0.2.10, 2001:db8::10";
    assert.deepEqual(
      [...loadRuntimeConfig().allowedClientIps],
      ["192.0.2.10", "2001:db8::10"],
    );
    assert.equal(normalizeRemoteAddress("::ffff:192.0.2.10"), "192.0.2.10");
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("192.0.2.10"), false);
    const allowed = new Set(["192.0.2.10"]);
    assert.equal(clientIpAllowed("127.0.0.1", allowed), true);
    assert.equal(clientIpAllowed("192.0.2.10", allowed), true);
    assert.equal(clientIpAllowed("192.0.2.11", allowed), false);
    assert.equal(clientIpAllowed("192.0.2.11", new Set()), true);

    process.env.VAL_BRIDGE_ALLOWED_CLIENT_IPS = "not-an-ip";
    assert.throws(() => loadRuntimeConfig(), /must contain exact IP addresses/);
  } finally {
    if (original === undefined) {
      delete process.env.VAL_BRIDGE_ALLOWED_CLIENT_IPS;
    } else {
      process.env.VAL_BRIDGE_ALLOWED_CLIENT_IPS = original;
    }
  }
});
