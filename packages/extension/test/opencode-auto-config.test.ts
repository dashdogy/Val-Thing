import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenCodeAutoConfigState,
  extensionVersionWasUpdated,
  openCodeAutoConfigReady,
  openCodeAutoConfigRetryMinutes,
  recordOpenCodeAutoConfigFailure,
  restoreOpenCodeAutoConfigState,
} from "../src/opencode-auto-config.js";

test("restores only a pending migration for the running extension version", () => {
  const state = createOpenCodeAutoConfigState("1.2.3", 123);
  assert.deepEqual(state, {
    targetVersion: "1.2.3",
    requestedAt: 123,
    attempts: 0,
  });
  assert.deepEqual(restoreOpenCodeAutoConfigState(state, "1.2.3"), state);
  assert.equal(restoreOpenCodeAutoConfigState(state, "1.2.2"), undefined);
  assert.equal(
    restoreOpenCodeAutoConfigState({ ...state, attempts: -1 }, "1.2.3"),
    undefined,
  );
  assert.throws(
    () => createOpenCodeAutoConfigState("not-a-version"),
    /target version is invalid/,
  );
});

test("recognizes a persisted semantic version change as an update", () => {
  assert.equal(extensionVersionWasUpdated("1.2.2", "1.2.3"), true);
  assert.equal(extensionVersionWasUpdated("1.2.3", "1.2.3"), false);
  assert.equal(extensionVersionWasUpdated(undefined, "1.2.3"), false);
  assert.equal(extensionVersionWasUpdated("invalid", "1.2.3"), false);
});

test("records bounded failures with an exponential retry delay", () => {
  const failed = recordOpenCodeAutoConfigFailure(
    createOpenCodeAutoConfigState("1.2.3", 123),
    new Error("temporary model lookup failure"),
  );
  assert.deepEqual(failed, {
    targetVersion: "1.2.3",
    requestedAt: 123,
    attempts: 1,
    lastError: "temporary model lookup failure",
  });
  assert.equal(openCodeAutoConfigRetryMinutes(0), 1);
  assert.equal(openCodeAutoConfigRetryMinutes(1), 1);
  assert.equal(openCodeAutoConfigRetryMinutes(4), 8);
  assert.equal(openCodeAutoConfigRetryMinutes(20), 60);
});

test("waits for the authenticated bridge and complete Val readiness", () => {
  assert.equal(
    openCodeAutoConfigReady({
      bridgeAuthenticated: true,
      valSession: true,
      valSocket: true,
      compatible: true,
    }),
    true,
  );
  for (const field of [
    "bridgeAuthenticated",
    "valSession",
    "valSocket",
    "compatible",
  ] as const) {
    assert.equal(
      openCodeAutoConfigReady({
        bridgeAuthenticated: true,
        valSession: true,
        valSocket: true,
        compatible: true,
        [field]: false,
      }),
      false,
    );
  }
});
