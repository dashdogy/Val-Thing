import assert from "node:assert/strict";
import test from "node:test";
import { COMPANION_LAUNCH_URL } from "@val-bridge/protocol";
import { parseCliOptions } from "../src/cli-options.js";

test("accepts only the fixed browser launch URL", () => {
  assert.deepEqual(parseCliOptions(["--launch-url", COMPANION_LAUNCH_URL]), {
    help: false,
    launchUrl: COMPANION_LAUNCH_URL,
    repairLaunchHandler: false,
  });
  assert.throws(
    () => parseCliOptions(["--launch-url", "val-openai-bridge://other"]),
    /launch URL is invalid/,
  );
  assert.throws(() => parseCliOptions(["--launch-url"]), /requires a URL/);
});

test("accepts the internal launch-handler repair mode", () => {
  assert.deepEqual(parseCliOptions(["--repair-launch-handler"]), {
    help: false,
    repairLaunchHandler: true,
  });
});
