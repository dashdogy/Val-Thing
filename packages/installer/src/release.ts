export const SOURCE_REPOSITORY = "https://github.com/dashdogy/Val-Thing";
export const DEFAULT_RELEASE_API =
  "https://api.github.com/repos/dashdogy/Val-Thing/releases/latest";

export type ReleaseAsset = {
  name: string;
  sha256: string;
  size: number;
};

export type ReleaseManifest = {
  schema_version: 1;
  version: string;
  channel: "stable";
  published_at: string;
  minimum_node_version: string;
  source: {
    repository: string;
    commit: string;
    tag: string;
  };
  assets: {
    portable_bundle: ReleaseAsset;
    extension: ReleaseAsset;
    installer: ReleaseAsset;
  };
};

export type ResolvedReleaseAsset = ReleaseAsset & {
  downloadUrl: string;
};

export type ResolvedRelease = Omit<ReleaseManifest, "assets"> & {
  releaseUrl: string;
  assets: {
    portable_bundle: ResolvedReleaseAsset;
    extension: ResolvedReleaseAsset;
    installer: ResolvedReleaseAsset;
  };
};

type GitHubRelease = {
  draft?: boolean;
  html_url?: string;
  published_at?: string;
  tag_name?: string;
  assets?: Array<{
    name?: string;
    size?: number;
    browser_download_url?: string;
  }>;
};

function isReleaseAsset(value: unknown): value is ReleaseAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Record<string, unknown>;
  return (
    typeof asset.name === "string" &&
    /^[A-Za-z0-9._-]+$/.test(asset.name) &&
    typeof asset.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(asset.sha256) &&
    typeof asset.size === "number" &&
    Number.isSafeInteger(asset.size) &&
    asset.size > 0 &&
    asset.size <= 256 * 1024 * 1024
  );
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== "object") {
    throw new Error("The release manifest is not an object.");
  }
  const manifest = value as Partial<ReleaseManifest>;
  const minimumNodeVersion =
    typeof manifest.minimum_node_version === "string"
      ? manifest.minimum_node_version
      : "";
  const minimumNodeMajor = Number.parseInt(
    minimumNodeVersion.split(".")[0] ?? "",
    10,
  );
  if (
    manifest.schema_version !== 1 ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    manifest.channel !== "stable" ||
    !Number.isFinite(Date.parse(String(manifest.published_at))) ||
    !/^\d+\.\d+\.\d+$/.test(minimumNodeVersion) ||
    minimumNodeMajor < 24 ||
    !manifest.source ||
    manifest.source.repository !== SOURCE_REPOSITORY ||
    manifest.source.tag !== `v${manifest.version}` ||
    typeof manifest.source.commit !== "string" ||
    !/^[a-f0-9]{40}$/i.test(manifest.source.commit) ||
    !manifest.assets ||
    !isReleaseAsset(manifest.assets.portable_bundle) ||
    !isReleaseAsset(manifest.assets.extension) ||
    !isReleaseAsset(manifest.assets.installer)
  ) {
    throw new Error("The release manifest failed validation.");
  }
  const names = Object.values(manifest.assets).map((asset) => asset.name);
  if (new Set(names).size !== names.length) {
    throw new Error("Release asset names must be unique.");
  }
  return manifest as ReleaseManifest;
}

function validateFetchUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error(
      "Release downloads must use HTTPS or a loopback test server.",
    );
  }
  return url.toString();
}

export async function readResponseBytes(
  response: Response,
  maximumBytes: number,
) {
  if (!response.ok) {
    throw new Error(`The release service returned ${response.status}.`);
  }
  const lengthHeader = response.headers.get("content-length");
  const declaredLength =
    lengthHeader === null ? undefined : Number(lengthHeader);
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new Error("The release response is unexpectedly large.");
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("The release response is unexpectedly large.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function readJsonResponse(response: Response, maximumBytes: number) {
  return JSON.parse(
    (await readResponseBytes(response, maximumBytes)).toString("utf8"),
  ) as unknown;
}

export async function resolveLatestRelease(
  options: {
    apiUrl?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<ResolvedRelease> {
  const fetcher = options.fetcher ?? fetch;
  const apiUrl = validateFetchUrl(options.apiUrl ?? DEFAULT_RELEASE_API);
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "Val-Bridge-Installer",
    "x-github-api-version": "2022-11-28",
  };
  const github = (await readJsonResponse(
    await fetcher(apiUrl, { headers }),
    2 * 1024 * 1024,
  )) as GitHubRelease;
  if (
    !github ||
    github.draft ||
    !github.tag_name ||
    !Array.isArray(github.assets)
  ) {
    throw new Error("The latest GitHub release is unavailable.");
  }

  const manifestAsset = github.assets.find(
    (asset) => asset.name === "latest.json",
  );
  if (!manifestAsset?.browser_download_url) {
    throw new Error("The GitHub release has no latest.json asset.");
  }
  const manifest = parseReleaseManifest(
    await readJsonResponse(
      await fetcher(validateFetchUrl(manifestAsset.browser_download_url), {
        headers: { "user-agent": headers["user-agent"] },
      }),
      1024 * 1024,
    ),
  );
  if (github.tag_name !== manifest.source.tag) {
    throw new Error("The GitHub release tag does not match latest.json.");
  }

  const resolvedAssets = {} as ResolvedRelease["assets"];
  for (const key of ["portable_bundle", "extension", "installer"] as const) {
    const asset = manifest.assets[key];
    const githubAsset = github.assets.find(
      (candidate) => candidate.name === asset.name,
    );
    if (!githubAsset?.browser_download_url || githubAsset.size !== asset.size) {
      throw new Error(`Release asset validation failed for ${asset.name}.`);
    }
    resolvedAssets[key] = {
      ...asset,
      downloadUrl: validateFetchUrl(githubAsset.browser_download_url),
    };
  }

  return {
    ...manifest,
    published_at: github.published_at ?? manifest.published_at,
    releaseUrl:
      github.html_url ??
      `${SOURCE_REPOSITORY}/releases/tag/${manifest.source.tag}`,
    assets: resolvedAssets,
  };
}
