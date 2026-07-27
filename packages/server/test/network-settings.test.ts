import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hostForNetworkScope,
  NetworkSettingsStore,
  networkScopeForHost,
} from "../src/network-settings.js";

test("persists explicit loopback and LAN network scopes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "val-network-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const settings = await NetworkSettingsStore.open(directory);
  assert.equal(settings.get(), undefined);
  await settings.set("loopback");
  assert.equal((await NetworkSettingsStore.open(directory)).get(), "loopback");
  await settings.set("lan");
  assert.equal((await NetworkSettingsStore.open(directory)).get(), "lan");
  assert.equal(hostForNetworkScope("loopback"), "127.0.0.1");
  assert.equal(hostForNetworkScope("lan"), "0.0.0.0");
  assert.equal(networkScopeForHost("127.0.0.1"), "loopback");
  assert.equal(networkScopeForHost("0.0.0.0"), "lan");
});

test("rejects malformed persisted network settings", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "val-network-settings-invalid-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "network-settings.json"),
    JSON.stringify({ version: 1, scope: "internet" }),
  );
  await assert.rejects(
    NetworkSettingsStore.open(directory),
    /network settings are invalid/,
  );
});
