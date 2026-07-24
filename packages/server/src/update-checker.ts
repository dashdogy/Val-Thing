const DEFAULT_RELEASE_API =
  "https://api.github.com/repos/dashdogy/Val-Thing/releases/latest";
const SOURCE_REPOSITORY = "https://github.com/dashdogy/Val-Thing";
const MAX_RELEASE_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_CACHE_MS = 15 * 60_000;

type LatestRelease = {
  version: string;
  releaseUrl: string;
};

export type BridgeUpdateStatus = {
  currentVersion: string;
  checkedAt: number;
  updateAvailable: boolean;
  latestVersion?: string;
  releaseUrl?: string;
  error?: string;
};

type UpdateCheckerOptions = {
  apiUrl?: string;
  fetcher?: typeof fetch;
  cacheMs?: number;
  now?: () => number;
};

function parseVersion(version: string) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

export function compareVersions(left: string, right: string) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    throw new Error("Bridge update versions must use major.minor.patch.");
  }
  for (let index = 0; index < 3; index += 1) {
    const difference = (parsedLeft[index] ?? 0) - (parsedRight[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function releaseFromResponse(value: unknown): LatestRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The release service returned an invalid response.");
  }
  const release = value as Record<string, unknown>;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  const releaseUrl =
    typeof release.html_url === "string" ? release.html_url : "";
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const assetNames = new Set(
    assets
      .filter((asset): asset is Record<string, unknown> =>
        Boolean(asset && typeof asset === "object" && !Array.isArray(asset)),
      )
      .map((asset) => asset.name)
      .filter((name): name is string => typeof name === "string"),
  );
  if (
    release.draft === true ||
    release.prerelease === true ||
    !parseVersion(version) ||
    releaseUrl !== `${SOURCE_REPOSITORY}/releases/tag/v${version}` ||
    !assetNames.has("latest.json") ||
    !assetNames.has(`val-openai-local-bridge-${version}.zip`) ||
    !assetNames.has(`val-openai-local-bridge-extension-${version}.zip`)
  ) {
    throw new Error("The latest release is incomplete or invalid.");
  }
  return { version, releaseUrl };
}

async function readResponseText(response: Response) {
  if (!response.ok) {
    throw new Error(`The release service returned ${response.status}.`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > MAX_RELEASE_RESPONSE_BYTES) {
      throw new Error("The release response is unexpectedly large.");
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RELEASE_RESPONSE_BYTES) {
        throw new Error("The release response is unexpectedly large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class UpdateChecker {
  private readonly apiUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cached?: { release: LatestRelease; expiresAt: number };
  private inFlight?: Promise<LatestRelease>;

  constructor(options: UpdateCheckerOptions = {}) {
    this.apiUrl =
      options.apiUrl ??
      process.env.VAL_BRIDGE_RELEASE_API?.trim() ??
      DEFAULT_RELEASE_API;
    this.fetcher = options.fetcher ?? fetch;
    this.cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
    this.now = options.now ?? Date.now;
  }

  async check(
    currentVersion: string,
    options: { force?: boolean } = {},
  ): Promise<BridgeUpdateStatus> {
    if (!parseVersion(currentVersion)) {
      throw new Error("The current extension version is invalid.");
    }
    const checkedAt = this.now();
    try {
      const release = await this.latest(options.force === true);
      return {
        currentVersion,
        checkedAt,
        updateAvailable: compareVersions(release.version, currentVersion) > 0,
        latestVersion: release.version,
        releaseUrl: release.releaseUrl,
      };
    } catch (error) {
      return {
        currentVersion,
        checkedAt,
        updateAvailable: false,
        error: error instanceof Error ? error.message : "Update check failed.",
      };
    }
  }

  private async latest(force: boolean) {
    const now = this.now();
    if (!force && this.cached && this.cached.expiresAt > now) {
      return this.cached.release;
    }
    if (!force && this.inFlight) return await this.inFlight;

    const request = this.fetchLatest();
    this.inFlight = request;
    try {
      const release = await request;
      this.cached = { release, expiresAt: this.now() + this.cacheMs };
      return release;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  private async fetchLatest() {
    const response = await this.fetcher(this.apiUrl, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "val-openai-local-bridge",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await readResponseText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("The release service returned invalid JSON.");
    }
    return releaseFromResponse(parsed);
  }
}
