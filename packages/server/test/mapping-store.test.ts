import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MappingStore } from "../src/mapping-store.js";

test("loads legacy chat mappings and persists native mappings without content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "val-bridge-mappings-test-"));
  const path = join(directory, "response-mappings.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      mappings: [
        {
          responseId: "resp_legacy",
          chatId: "val-chat-legacy",
          createdAt: 1,
        },
        {
          responseId: "resp_native",
          nativeResponseId: "resp_upstream",
          createdAt: 2,
        },
        { responseId: "resp_invalid", createdAt: 3 },
      ],
    }),
    "utf8",
  );

  const store = await MappingStore.open(directory);
  assert.equal(store.get("resp_legacy")?.chatId, "val-chat-legacy");
  assert.equal(store.get("resp_native")?.nativeResponseId, "resp_upstream");
  assert.equal(store.get("resp_invalid"), undefined);

  await store.setNative("resp_new", "resp_native_new");
  const persisted = await readFile(path, "utf8");
  assert.match(persisted, /"nativeResponseId": "resp_native_new"/);
  assert.ok(!persisted.includes("prompt"));
  assert.ok(!persisted.includes("response body"));
});

test("serializes concurrent mapping writes without losing continuations", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "val-bridge-concurrent-mappings-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = await MappingStore.open(directory);
  const responseIds = Array.from(
    { length: 20 },
    (_, index) => `resp_concurrent_${index}`,
  );
  await Promise.all(
    responseIds.map((responseId) =>
      store.setNative(responseId, `${responseId}_upstream`),
    ),
  );

  const reopened = await MappingStore.open(directory);
  for (const responseId of responseIds) {
    assert.equal(
      reopened.get(responseId)?.nativeResponseId,
      `${responseId}_upstream`,
    );
  }
});
