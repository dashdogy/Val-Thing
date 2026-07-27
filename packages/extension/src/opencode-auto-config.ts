export type OpenCodeAutoConfigState = {
  targetVersion: string;
  requestedAt: number;
  attempts: number;
  lastError?: string;
};

type OpenCodeAutoConfigReadiness = {
  bridgeAuthenticated: boolean;
  valSession: boolean;
  valSocket: boolean;
  compatible: boolean;
};

const VERSION = /^\d+\.\d+\.\d+$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createOpenCodeAutoConfigState(
  targetVersion: string,
  requestedAt = Date.now(),
): OpenCodeAutoConfigState {
  if (!VERSION.test(targetVersion)) {
    throw new Error("The OpenCode configuration target version is invalid.");
  }
  return { targetVersion, requestedAt, attempts: 0 };
}

export function extensionVersionWasUpdated(
  previousVersion: unknown,
  currentVersion: string,
) {
  return (
    typeof previousVersion === "string" &&
    VERSION.test(previousVersion) &&
    VERSION.test(currentVersion) &&
    previousVersion !== currentVersion
  );
}

export function restoreOpenCodeAutoConfigState(
  value: unknown,
  currentVersion: string,
): OpenCodeAutoConfigState | undefined {
  const stored = record(value);
  if (
    !stored ||
    stored.targetVersion !== currentVersion ||
    !VERSION.test(String(stored.targetVersion)) ||
    typeof stored.requestedAt !== "number" ||
    !Number.isSafeInteger(stored.requestedAt) ||
    stored.requestedAt <= 0 ||
    typeof stored.attempts !== "number" ||
    !Number.isSafeInteger(stored.attempts) ||
    stored.attempts < 0 ||
    stored.attempts > 100
  ) {
    return undefined;
  }
  return {
    targetVersion: currentVersion,
    requestedAt: stored.requestedAt,
    attempts: stored.attempts,
    ...(typeof stored.lastError === "string" && stored.lastError
      ? { lastError: stored.lastError.slice(0, 240) }
      : {}),
  };
}

export function recordOpenCodeAutoConfigFailure(
  state: OpenCodeAutoConfigState,
  error: unknown,
): OpenCodeAutoConfigState {
  const message =
    error instanceof Error ? error.message : String(error || "Unknown error.");
  return {
    ...state,
    attempts: Math.min(100, state.attempts + 1),
    lastError: message.slice(0, 240),
  };
}

export function openCodeAutoConfigRetryMinutes(attempts: number) {
  if (attempts <= 0) return 1;
  return Math.min(60, 2 ** Math.min(attempts - 1, 6));
}

export function openCodeAutoConfigReady(
  readiness: OpenCodeAutoConfigReadiness,
) {
  return (
    readiness.bridgeAuthenticated &&
    readiness.valSession &&
    readiness.valSocket &&
    readiness.compatible
  );
}
