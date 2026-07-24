import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, UpdateChecker } from "../src/update-checker.js";

function release(version: string) {
  return {
    draft: false,
    prerelease: false,
    tag_name: `v${version}`,
    html_url: `https://github.com/dashdogy/Val-Thing/releases/tag/v${version}`,
    assets: [
      { name: "latest.json" },
      { name: `val-openai-local-bridge-${version}.zip` },
      { name: `val-openai-local-bridge-extension-${version}.zip` },
    ],
  };
}

test("compares strict semantic bridge versions", () => {
  assert.equal(compareVersions("1.2.3", "1.2.2"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3", "2.0.0"), -1);
  assert.throws(
    () => compareVersions("latest", "1.0.0"),
    /major\.minor\.patch/,
  );
});

test("discovers and caches a complete newer release", async () => {
  let requests = 0;
  const checker = new UpdateChecker({
    cacheMs: 60_000,
    now: () => 123_000,
    fetcher: async () => {
      requests += 1;
      return Response.json(release("1.3.0"));
    },
  });

  assert.deepEqual(await checker.check("1.2.3"), {
    currentVersion: "1.2.3",
    checkedAt: 123_000,
    updateAvailable: true,
    latestVersion: "1.3.0",
    releaseUrl: "https://github.com/dashdogy/Val-Thing/releases/tag/v1.3.0",
  });
  assert.equal((await checker.check("1.3.0")).updateAvailable, false);
  assert.equal(requests, 1);
});

test("turns malformed releases and network failures into safe status", async () => {
  const incomplete = new UpdateChecker({
    fetcher: async () =>
      Response.json({
        ...release("1.3.0"),
        assets: [{ name: "latest.json" }],
      }),
  });
  const malformed = await incomplete.check("1.2.3");
  assert.equal(malformed.updateAvailable, false);
  assert.match(malformed.error ?? "", /incomplete or invalid/);

  const offline = new UpdateChecker({
    fetcher: async () => {
      throw new Error("offline");
    },
  });
  const offlineStatus = await offline.check("1.2.3");
  assert.equal(offlineStatus.currentVersion, "1.2.3");
  assert.equal(typeof offlineStatus.checkedAt, "number");
  assert.equal(offlineStatus.updateAvailable, false);
  assert.equal(offlineStatus.error, "offline");
});
