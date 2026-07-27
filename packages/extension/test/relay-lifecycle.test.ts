import assert from "node:assert/strict";
import test from "node:test";
import {
  RelayLifecycleRegistry,
  throwIfRelayCancelled,
} from "../src/relay-lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("retains cancellation that arrives during asynchronous preparation", async () => {
  const registry = new RelayLifecycleRegistry();
  const preparation = deferred();
  let submitted = false;

  const running = registry.run("relay-1", async (signal) => {
    await preparation.promise;
    throwIfRelayCancelled(signal);
    submitted = true;
  });

  assert.deepEqual(registry.ids(), ["relay-1"]);
  assert.equal(registry.cancel("relay-1"), true);
  preparation.resolve();
  await assert.rejects(running, (error: unknown) => {
    return error instanceof DOMException && error.name === "AbortError";
  });
  assert.equal(submitted, false);
  assert.deepEqual(registry.ids(), []);
});

test("cancels every active relay during a bridge disconnect", async () => {
  const registry = new RelayLifecycleRegistry();
  const preparation = deferred();
  const outcomes = ["relay-1", "relay-2"].map((requestId) =>
    registry.run(requestId, async (signal) => {
      await preparation.promise;
      throwIfRelayCancelled(signal);
    }),
  );

  registry.cancelAll();
  preparation.resolve();
  const settled = await Promise.allSettled(outcomes);
  assert.ok(
    settled.every(
      (outcome) =>
        outcome.status === "rejected" &&
        outcome.reason instanceof DOMException &&
        outcome.reason.name === "AbortError",
    ),
  );
  assert.deepEqual(registry.ids(), []);
});

test("rejects duplicate active relay identifiers", async () => {
  const registry = new RelayLifecycleRegistry();
  const preparation = deferred();
  const running = registry.run("relay-1", async () => preparation.promise);

  await assert.rejects(
    registry.run("relay-1", async () => undefined),
    /already active/,
  );
  preparation.resolve();
  await running;
});
