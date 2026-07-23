import assert from "node:assert/strict";
import test from "node:test";
import {
  parseReleaseManifest,
  resolveLatestRelease,
  SOURCE_REPOSITORY,
} from "../src/release.js";

const sha256 = "a".repeat(64);
const manifest = {
  schema_version: 1,
  version: "1.2.3",
  channel: "stable",
  published_at: "2026-07-23T00:00:00.000Z",
  minimum_node_version: "24.0.0",
  source: {
    repository: SOURCE_REPOSITORY,
    commit: "b".repeat(40),
    tag: "v1.2.3",
  },
  assets: {
    portable_bundle: {
      name: "bridge-1.2.3.zip",
      sha256,
      size: 101,
    },
    extension: {
      name: "extension-1.2.3.zip",
      sha256: "b".repeat(64),
      size: 102,
    },
    installer: {
      name: "install.mjs",
      sha256: "c".repeat(64),
      size: 103,
    },
  },
} as const;

test("validates a stable portable release manifest", () => {
  assert.deepEqual(parseReleaseManifest(manifest), manifest);
  assert.throws(
    () =>
      parseReleaseManifest({
        ...manifest,
        source: { ...manifest.source, repository: "https://example.com" },
      }),
    /failed validation/,
  );
  assert.throws(
    () =>
      parseReleaseManifest({
        ...manifest,
        assets: {
          ...manifest.assets,
          installer: {
            ...manifest.assets.installer,
            name: manifest.assets.extension.name,
          },
        },
      }),
    /unique/,
  );
});

test("resolves release assets through GitHub metadata", async () => {
  const apiUrl = "http://127.0.0.1:3000/releases/latest";
  const github = {
    tag_name: "v1.2.3",
    html_url: "https://github.com/dashdogy/Val-Thing/releases/tag/v1.2.3",
    published_at: manifest.published_at,
    assets: [
      {
        name: "latest.json",
        size: 1,
        browser_download_url: "http://127.0.0.1:3000/latest.json",
      },
      ...Object.values(manifest.assets).map((asset) => ({
        name: asset.name,
        size: asset.size,
        browser_download_url: `http://127.0.0.1:3000/${asset.name}`,
      })),
    ],
  };
  const fetcher = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    return new Response(JSON.stringify(url === apiUrl ? github : manifest), {
      headers: { "content-type": "application/json" },
    });
  };

  const resolved = await resolveLatestRelease({
    apiUrl,
    fetcher: fetcher as typeof fetch,
  });
  assert.equal(resolved.version, "1.2.3");
  assert.equal(
    resolved.assets.portable_bundle.downloadUrl,
    "http://127.0.0.1:3000/bridge-1.2.3.zip",
  );
});
