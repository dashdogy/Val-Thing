import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  launchHandlerRepairCommand,
  repairInstalledLaunchHandler,
} from "../src/launch-handler-repair.js";

test("builds a repair command for the installed launcher", () => {
  const installRoot = resolve("test install");
  assert.deepEqual(launchHandlerRepairCommand(installRoot, "node-test"), {
    file: "node-test",
    arguments: [
      join(installRoot, "runtime", "start.mjs"),
      "--install-dir",
      installRoot,
      "--repair-launch-handler",
    ],
  });
});

test("repairs an installed handler without starting another companion", async () => {
  const installRoot = resolve("test install");
  const calls: Array<{ file: string; arguments: string[] }> = [];
  const repaired = await repairInstalledLaunchHandler({
    installRoot,
    nodePath: "node-test",
    environment: {},
    runCommand: async (file, arguments_) => {
      calls.push({ file, arguments: arguments_ });
    },
  });

  assert.equal(repaired, true);
  assert.deepEqual(calls, [
    launchHandlerRepairCommand(installRoot, "node-test"),
  ]);
});

test("skips repair during portable verification", async () => {
  let called = false;
  const repaired = await repairInstalledLaunchHandler({
    installRoot: resolve("test install"),
    environment: { VAL_BRIDGE_SKIP_PROTOCOL_REGISTRATION: "1" },
    runCommand: async () => {
      called = true;
    },
  });

  assert.equal(repaired, false);
  assert.equal(called, false);
});
