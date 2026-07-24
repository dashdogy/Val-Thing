export type ExtensionUpdateStatus = {
  state: "unknown" | "current" | "available" | "error" | "installing";
  currentVersion: string;
  latestVersion?: string;
  checkedAt?: number;
  releaseUrl?: string;
  message?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function version(value: unknown) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value)
    ? value
    : undefined;
}

export function createUpdateStatus(
  currentVersion: string,
): ExtensionUpdateStatus {
  return { state: "unknown", currentVersion };
}

export function parseCompanionUpdateStatus(
  value: unknown,
  currentVersion: string,
): ExtensionUpdateStatus {
  const response = record(value);
  const reportedCurrent = version(response?.current_version);
  const latestVersion = version(response?.latest_version);
  const checkedAt =
    typeof response?.checked_at === "number" &&
    Number.isSafeInteger(response.checked_at) &&
    response.checked_at > 0
      ? response.checked_at
      : undefined;
  const releaseUrl =
    typeof response?.release_url === "string" &&
    response.release_url ===
      `https://github.com/dashdogy/Val-Thing/releases/tag/v${latestVersion}`
      ? response.release_url
      : undefined;
  if (
    !response ||
    reportedCurrent !== currentVersion ||
    typeof response.update_available !== "boolean" ||
    !checkedAt ||
    (response.update_available && (!latestVersion || !releaseUrl))
  ) {
    throw new Error("The companion returned an invalid update status.");
  }
  if (typeof response.error === "string" && response.error) {
    return {
      state: "error",
      currentVersion,
      checkedAt,
      message: response.error.slice(0, 240),
    };
  }
  return {
    state: response.update_available ? "available" : "current",
    currentVersion,
    ...(latestVersion ? { latestVersion } : {}),
    checkedAt,
    ...(releaseUrl ? { releaseUrl } : {}),
  };
}

export function restoreUpdateStatus(
  value: unknown,
  currentVersion: string,
): ExtensionUpdateStatus {
  const stored = record(value);
  if (
    !stored ||
    stored.currentVersion !== currentVersion ||
    !["unknown", "current", "available", "error", "installing"].includes(
      String(stored.state),
    )
  ) {
    return createUpdateStatus(currentVersion);
  }
  return {
    state: stored.state as ExtensionUpdateStatus["state"],
    currentVersion,
    ...(version(stored.latestVersion)
      ? { latestVersion: String(stored.latestVersion) }
      : {}),
    ...(typeof stored.checkedAt === "number" &&
    Number.isSafeInteger(stored.checkedAt) &&
    stored.checkedAt > 0
      ? { checkedAt: stored.checkedAt }
      : {}),
    ...(typeof stored.releaseUrl === "string"
      ? { releaseUrl: stored.releaseUrl.slice(0, 300) }
      : {}),
    ...(typeof stored.message === "string"
      ? { message: stored.message.slice(0, 240) }
      : {}),
  };
}
