import assert from "node:assert/strict";
import test from "node:test";
import {
  createUpdateStatus,
  parseCompanionUpdateStatus,
  restoreUpdateStatus,
} from "../src/update-status.js";

test("parses available and current companion update states", () => {
  assert.deepEqual(
    parseCompanionUpdateStatus(
      {
        current_version: "1.2.3",
        checked_at: 123,
        update_available: true,
        latest_version: "1.3.0",
        release_url:
          "https://github.com/dashdogy/Val-Thing/releases/tag/v1.3.0",
      },
      "1.2.3",
    ),
    {
      state: "available",
      currentVersion: "1.2.3",
      checkedAt: 123,
      latestVersion: "1.3.0",
      releaseUrl: "https://github.com/dashdogy/Val-Thing/releases/tag/v1.3.0",
    },
  );
  assert.equal(
    parseCompanionUpdateStatus(
      {
        current_version: "1.2.3",
        checked_at: 124,
        update_available: false,
        latest_version: "1.2.3",
        release_url:
          "https://github.com/dashdogy/Val-Thing/releases/tag/v1.2.3",
      },
      "1.2.3",
    ).state,
    "current",
  );
});

test("rejects mismatched versions and untrusted release URLs", () => {
  assert.throws(
    () =>
      parseCompanionUpdateStatus(
        {
          current_version: "1.2.2",
          checked_at: 123,
          update_available: false,
        },
        "1.2.3",
      ),
    /invalid update status/,
  );
  assert.throws(
    () =>
      parseCompanionUpdateStatus(
        {
          current_version: "1.2.3",
          checked_at: 123,
          update_available: true,
          latest_version: "1.3.0",
          release_url: "https://example.test/update",
        },
        "1.2.3",
      ),
    /invalid update status/,
  );
});

test("restores only status for the currently running extension version", () => {
  assert.deepEqual(restoreUpdateStatus({}, "1.2.3"), {
    state: "unknown",
    currentVersion: "1.2.3",
  });
  assert.deepEqual(
    restoreUpdateStatus(
      {
        state: "installing",
        currentVersion: "1.2.3",
        latestVersion: "1.3.0",
      },
      "1.2.3",
    ),
    {
      state: "installing",
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
    },
  );
  assert.deepEqual(
    restoreUpdateStatus(
      { state: "available", currentVersion: "1.2.2" },
      "1.2.3",
    ),
    createUpdateStatus("1.2.3"),
  );
});
