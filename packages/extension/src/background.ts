import {
  COMPANION_LAUNCH_URL,
  collapseRepeatedJson,
  PROTOCOL_VERSION,
  type ExtensionStatus,
  type ExtensionToServerMessage,
  type JsonObject,
  type OpenAIMessage,
  type OpenAIToolCall,
  type PairResponse,
  type RelayCompletionRequest,
  type RelayError,
  type RelayOpenAIHttpRequest,
  type RelayRequest,
  type RelayResponsesRequest,
  type ServerToExtensionMessage,
  type ValModel,
} from "@val-bridge/protocol";
import { io, type Socket } from "socket.io-client";
import {
  assistantTextFromContent,
  buildValHistory,
  completionPayload,
  findValNativeToolTraces,
  isBridgeClientToolEvent,
  parseClientToolExecution,
  reasoningTextFromRecord,
  reasoningTextFromStatus,
  resolveClientToolResponse,
  splitValReasoningMarkup,
  storedMessagesToOpenAI,
  type BuiltHistory,
  type ParsedClientToolCall,
} from "./relay-utils.js";
import {
  RelayLifecycleRegistry,
  throwIfRelayCancelled,
} from "./relay-lifecycle.js";
import {
  base64ToBytes,
  bytesToBase64,
  openAIHttpRequestHeaders,
  openAIHttpResponseHeaders,
  valOpenAIHttpUrl,
} from "./openai-http-relay.js";
import {
  openAIHttpGeneration,
  OpenAIHttpUsageCapture,
} from "./openai-usage-capture.js";
import {
  createOpenCodeAutoConfigState,
  extensionVersionWasUpdated,
  openCodeAutoConfigReady,
  openCodeAutoConfigRetryMinutes,
  recordOpenCodeAutoConfigFailure,
  restoreOpenCodeAutoConfigState,
  type OpenCodeAutoConfigState,
} from "./opencode-auto-config.js";
import { SseParser, type ParsedSseEvent } from "./sse-parser.js";
import {
  createSessionUsageStats,
  newerUsageStats,
  recordUsageRequest,
  responseUsageDetails,
  restoreSessionUsageStats,
  settleUsageRequest,
  type SessionUsageStats,
  type UsageOutcome,
} from "./usage-stats.js";
import {
  actionBadgeText,
  createUpdateStatus,
  parseCompanionUpdateStatus,
  restoreUpdateStatus,
  type ExtensionUpdateStatus,
} from "./update-status.js";

const VAL_ORIGIN = "https://val.rmit.edu.au";
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8787";
const SESSION_TOKEN_KEY = "valSessionToken";
const BRIDGE_SECRET_KEY = "bridgeSecret";
const BRIDGE_URL_KEY = "bridgeUrl";
const USAGE_STATS_KEY = "usageStats";
const UPDATE_STATUS_KEY = "updateStatus";
const OPENCODE_AUTO_CONFIG_KEY = "openCodeAutoConfig";
const LAST_EXTENSION_VERSION_KEY = "lastExtensionVersion";
const UPDATE_ALARM_NAME = "val-bridge-update-check";
const OPENCODE_AUTO_CONFIG_ALARM_NAME = "val-bridge-opencode-config";
const UPDATE_CHECK_INTERVAL_MINUTES = 6 * 60;
const UPDATE_CHECK_MINIMUM_GAP_MS = 15 * 60_000;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const TOKEN_MESSAGE = "VAL_SESSION_UPDATE";
const GET_TOKEN_MESSAGE = "VAL_GET_SESSION_TOKEN";

type PopupStatus = ExtensionStatus & {
  bridgeConnected: boolean;
  bridgePaired: boolean;
  bridgeUrl: string;
  networkScope: "unknown" | "loopback" | "lan";
  clientIpAllowlist: boolean;
  clientApiKey?: string;
  update: ExtensionUpdateStatus;
  openCodeAutoConfig: {
    pending: boolean;
    attempts: number;
    lastError?: string;
  };
  stats: SessionUsageStats & { activeRequests: number };
};

type OpenCodeConfigureResult = {
  modelsConfigured: number;
  updated: boolean;
  backupCreated: boolean;
};

type MutableToolCall = {
  id: string;
  type: "function";
  argumentReplay?: string;
  function: { name: string; arguments: string };
};

type PendingCompletion = {
  requestId: string;
  request: RelayCompletionRequest;
  sessionId: string;
  chatId: string;
  exposedChatId?: string;
  stored: boolean;
  history: BuiltHistory;
  chatObject: Record<string, unknown>;
  modelItem: Record<string, unknown>;
  assistantContent: string;
  reasoningContent: string;
  toolCalls: Map<number, MutableToolCall>;
  interceptedClientToolCalls?: ParsedClientToolCall[];
  usage?: JsonObject;
  taskId?: string;
  finished: boolean;
  cancelRequested: boolean;
  statsSettled: boolean;
};

let valToken = "";
let valSocket: Socket | null = null;
let valSocketToken = "";
let bridgeSocket: WebSocket | null = null;
let bridgeAuthenticated = false;
let clientApiKey = "";
let companionNetworkScope: PopupStatus["networkScope"] = "unknown";
let companionClientIpAllowlist = false;
let bridgeReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let bridgeReconnectDelay = 1_000;
let modelCache: { expiresAt: number; models: ValModel[] } | null = null;
const pendingByRequest = new Map<string, PendingCompletion>();
const pendingByMessage = new Map<string, PendingCompletion>();
const relayLifecycles = new RelayLifecycleRegistry();
let usageStats = createSessionUsageStats();
let usageStatsWrite: Promise<void> = Promise.resolve();
let extensionUpdateStatus = createUpdateStatus(EXTENSION_VERSION);
let updateStatusWrite: Promise<void> = Promise.resolve();
let updateCheckPromise: Promise<ExtensionUpdateStatus> | undefined;
let openCodeAutoConfigState: OpenCodeAutoConfigState | undefined;
let openCodeAutoConfigPromise: Promise<void> | undefined;
let openCodeConfigurePromise: Promise<OpenCodeConfigureResult> | undefined;

function pendingMessageKey(
  sessionId: string,
  chatId: string,
  messageId: string,
) {
  return `${sessionId}:${chatId}:${messageId}`;
}

function persistUsageStats() {
  const snapshot = { ...usageStats };
  usageStatsWrite = usageStatsWrite
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({ [USAGE_STATS_KEY]: snapshot }));
  if (bridgeAuthenticated) {
    sendBridge({ type: "bridge.usage", stats: snapshot });
  }
}

function persistUpdateStatus() {
  const snapshot = { ...extensionUpdateStatus };
  updateStatusWrite = updateStatusWrite
    .catch(() => undefined)
    .then(() => chrome.storage.local.set({ [UPDATE_STATUS_KEY]: snapshot }));
}

function setExtensionUpdateStatus(status: ExtensionUpdateStatus) {
  extensionUpdateStatus = status;
  persistUpdateStatus();
  updateBadge();
}

async function scheduleOpenCodeAutoConfigRetry(
  delayMinutes: number,
  replace = false,
) {
  if (
    !openCodeAutoConfigState ||
    openCodeAutoConfigState.targetVersion !== EXTENSION_VERSION
  ) {
    return;
  }
  const scheduled = await chrome.alarms.get(OPENCODE_AUTO_CONFIG_ALARM_NAME);
  if (replace || !scheduled) {
    await chrome.alarms.create(OPENCODE_AUTO_CONFIG_ALARM_NAME, {
      delayInMinutes: delayMinutes,
    });
  }
}

async function markOpenCodeAutoConfigPending(targetVersion: string) {
  const state = createOpenCodeAutoConfigState(targetVersion);
  await chrome.storage.local.set({ [OPENCODE_AUTO_CONFIG_KEY]: state });
  if (targetVersion !== EXTENSION_VERSION) return;
  openCodeAutoConfigState = state;
  await scheduleOpenCodeAutoConfigRetry(1);
  requestAutomaticOpenCodeConfig();
}

async function completeOpenCodeAutoConfig(targetVersion: string) {
  if (openCodeAutoConfigState?.targetVersion !== targetVersion) return;
  openCodeAutoConfigState = undefined;
  await Promise.all([
    chrome.storage.local.remove(OPENCODE_AUTO_CONFIG_KEY),
    chrome.alarms.clear(OPENCODE_AUTO_CONFIG_ALARM_NAME),
  ]);
}

function requestAutomaticOpenCodeConfig() {
  if (openCodeAutoConfigPromise) return;
  openCodeAutoConfigPromise = maybeConfigureOpenCodeAfterUpdate().finally(
    () => {
      openCodeAutoConfigPromise = undefined;
    },
  );
  void openCodeAutoConfigPromise.catch(() => undefined);
}

async function maybeConfigureOpenCodeAfterUpdate() {
  const state = openCodeAutoConfigState;
  if (!state || state.targetVersion !== EXTENSION_VERSION) {
    return;
  }
  if (
    !openCodeAutoConfigReady({
      bridgeAuthenticated,
      valSession: extensionStatus.valSession,
      valSocket: extensionStatus.valSocket,
      compatible: extensionStatus.compatible,
    })
  ) {
    await scheduleOpenCodeAutoConfigRetry(1);
    return;
  }

  await scheduleOpenCodeAutoConfigRetry(1, true);
  try {
    await configureOpenCode();
    await completeOpenCodeAutoConfig(state.targetVersion);
  } catch (error) {
    if (openCodeAutoConfigState?.targetVersion !== state.targetVersion) {
      return;
    }
    const failed = recordOpenCodeAutoConfigFailure(state, error);
    openCodeAutoConfigState = failed;
    await chrome.storage.local.set({
      [OPENCODE_AUTO_CONFIG_KEY]: failed,
    });
    await scheduleOpenCodeAutoConfigRetry(
      openCodeAutoConfigRetryMinutes(failed.attempts),
      true,
    );
  }
}

function recordPendingRequest() {
  usageStats = recordUsageRequest(usageStats);
  persistUsageStats();
}

function settlePendingRequest(
  pending: PendingCompletion,
  outcome: UsageOutcome,
) {
  if (pending.statsSettled) return;
  pending.statsSettled = true;
  usageStats = settleUsageRequest(
    usageStats,
    pending.usage,
    outcome,
    Date.now(),
    pending.request.model,
    {
      reasoningSummaryAvailable: Boolean(pending.reasoningContent.trim()),
    },
  );
  persistUsageStats();
}

let extensionStatus: ExtensionStatus = {
  extensionConnected: true,
  valSession: false,
  valSocket: false,
  compatible: true,
  nativeResponses: true,
};

function relayError(
  error: unknown,
  fallbackCode = "val_upstream_error",
): RelayError {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const detail =
      typeof record.detail === "string"
        ? record.detail
        : typeof record.message === "string"
          ? record.message
          : record.error && typeof record.error === "object"
            ? String(
                (record.error as Record<string, unknown>).message ??
                  "Val request failed.",
              )
            : undefined;
    return {
      code: typeof record.code === "string" ? record.code : fallbackCode,
      message: detail ?? "Val request failed.",
      status: typeof record.status === "number" ? record.status : 502,
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    status: 502,
  };
}

function mergeStreamFragment(current: string, incoming: string) {
  if (!incoming || incoming === current) {
    return current;
  }
  return incoming.startsWith(current) ? incoming : current + incoming;
}

function mergeArgumentFragment(tool: MutableToolCall, incoming: string) {
  const current = tool.function.arguments;
  if (!incoming || incoming === current) return;
  if (tool.argumentReplay !== undefined) {
    const candidate = tool.argumentReplay + incoming;
    if (current.startsWith(candidate)) {
      tool.argumentReplay = candidate === current ? undefined : candidate;
      return;
    }
    tool.function.arguments = candidate.startsWith(current)
      ? candidate
      : current + candidate;
    tool.argumentReplay = undefined;
    return;
  }
  if (incoming.startsWith(current)) {
    tool.function.arguments = incoming;
  } else if (current.startsWith(incoming)) {
    tool.argumentReplay = incoming;
  } else {
    tool.function.arguments += incoming;
  }
}

function updateStatus(patch: Partial<ExtensionStatus>) {
  extensionStatus = { ...extensionStatus, ...patch, extensionConnected: true };
  updateBadge();
  sendBridge({ type: "bridge.status", status: extensionStatus });
  requestAutomaticOpenCodeConfig();
}

function activeRequestCount() {
  return new Set([
    ...relayLifecycles.ids(),
    ...[...pendingByRequest.values()]
      .filter((pending) => !pending.finished)
      .map((pending) => pending.requestId),
  ]).size;
}

function updateBadge() {
  const updateAvailable = extensionUpdateStatus.state === "available";
  const ready =
    bridgeAuthenticated &&
    extensionStatus.valSession &&
    extensionStatus.valSocket &&
    extensionStatus.compatible;
  const activeRequests = activeRequestCount();
  void chrome.action.setBadgeText({
    text: actionBadgeText(
      updateAvailable,
      activeRequests,
      ready ? "ON" : bridgeAuthenticated ? "!" : "",
    ),
  });
  void chrome.action.setBadgeBackgroundColor({
    color: updateAvailable ? "#2563eb" : ready ? "#1f9d68" : "#d97706",
  });
  void chrome.action.setTitle({
    title: updateAvailable
      ? "Val OpenAI Bridge - Update available"
      : activeRequests
        ? `Val OpenAI Bridge - ${activeRequests} active ${activeRequests === 1 ? "request" : "requests"}`
        : "Val OpenAI Bridge",
  });
}

function sendBridge(message: ExtensionToServerMessage) {
  if (bridgeSocket?.readyState === WebSocket.OPEN) {
    bridgeSocket.send(JSON.stringify(message));
  }
}

function cancelActiveRelays() {
  relayLifecycles.cancelAll();
  for (const pending of [...pendingByRequest.values()]) {
    if (!pending.finished) void cancelRelay(pending.requestId);
  }
}

async function getBridgeSettings() {
  const stored = await chrome.storage.local.get([
    BRIDGE_SECRET_KEY,
    BRIDGE_URL_KEY,
  ]);
  const secret =
    typeof stored[BRIDGE_SECRET_KEY] === "string"
      ? stored[BRIDGE_SECRET_KEY]
      : "";
  const rawUrl =
    typeof stored[BRIDGE_URL_KEY] === "string"
      ? stored[BRIDGE_URL_KEY]
      : DEFAULT_BRIDGE_URL;
  try {
    return {
      secret,
      url: normalizeBridgeUrl(rawUrl),
    };
  } catch {
    await chrome.storage.local.remove([BRIDGE_SECRET_KEY, BRIDGE_URL_KEY]);
    return {
      secret: "",
      url: DEFAULT_BRIDGE_URL,
    };
  }
}

function normalizeBridgeUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  const hasUnexpectedComponents =
    Boolean(url.username) ||
    Boolean(url.password) ||
    (url.pathname !== "" && url.pathname !== "/") ||
    Boolean(url.search) ||
    Boolean(url.hash);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    hasUnexpectedComponents
  ) {
    throw new Error(
      "The companion URL must be an http://127.0.0.1 origin without credentials or a path.",
    );
  }
  return url.origin;
}

async function setSessionToken(token: string) {
  if (token === valToken) return;
  valToken = token;
  modelCache = null;
  if (token) {
    await chrome.storage.session.set({ [SESSION_TOKEN_KEY]: token });
    updateStatus({ valSession: true, compatible: true, lastError: undefined });
    connectValSocket(token);
    void verifyValCompatibility();
  } else {
    await chrome.storage.session.remove(SESSION_TOKEN_KEY);
    valSocket?.disconnect();
    valSocket = null;
    valSocketToken = "";
    updateStatus({
      valSession: false,
      valSocket: false,
      lastError: "Open and sign in to Val.",
    });
    for (const pending of [...pendingByRequest.values()]) {
      failCompletion(pending, {
        code: "val_session_unavailable",
        message: "The Val session ended while the request was running.",
        status: 503,
      });
    }
  }
}

async function refreshTokenFromValTab() {
  const tabs = await chrome.tabs.query({ url: `${VAL_ORIGIN}/*` });
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const response = (await chrome.tabs.sendMessage(tab.id, {
        type: GET_TOKEN_MESSAGE,
      })) as { token?: string };
      if (response?.token) {
        await setSessionToken(response.token);
        return response.token;
      }
    } catch {
      // Try another Val tab.
    }
  }
  return "";
}

async function ensureToken() {
  if (valToken) return valToken;
  const stored = await chrome.storage.session.get(SESSION_TOKEN_KEY);
  if (
    typeof stored[SESSION_TOKEN_KEY] === "string" &&
    stored[SESSION_TOKEN_KEY]
  ) {
    valToken = stored[SESSION_TOKEN_KEY];
    updateStatus({ valSession: true });
    connectValSocket(valToken);
    return valToken;
  }
  return await refreshTokenFromValTab();
}

function connectValSocket(token: string) {
  if (valSocket && valSocketToken === token) return;
  valSocket?.disconnect();
  valSocketToken = token;
  valSocket = io(VAL_ORIGIN, {
    path: "/ws/socket.io",
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 5_000,
    auth: { token },
  });
  valSocket.on("connect", () => {
    updateStatus({ valSocket: true, lastError: undefined });
  });
  valSocket.on("disconnect", () => {
    updateStatus({ valSocket: false });
  });
  valSocket.on("connect_error", (error) => {
    updateStatus({ valSocket: false, lastError: error.message });
  });
  valSocket.on(
    "chat-events",
    (event: unknown, callback?: (value: unknown) => void) => {
      void handleValChatEvent(event, callback);
    },
  );
}

async function ensureValSocket() {
  const token = await ensureToken();
  if (!token)
    throw {
      code: "val_session_unavailable",
      message: "Open and sign in to Val.",
      status: 503,
    };
  connectValSocket(token);
  if (valSocket?.connected && valSocket.id) return valSocket;

  return await new Promise<Socket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject({
        code: "val_socket_unavailable",
        message: "Val's chat connection did not become ready.",
        status: 503,
      });
    }, 10_000);
    const onConnect = () => {
      cleanup();
      if (valSocket) resolve(valSocket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      valSocket?.off("connect", onConnect);
      valSocket?.off("connect_error", onError);
    };
    valSocket?.once("connect", onConnect);
    valSocket?.once("connect_error", onError);
  });
}

async function valFetch(path: string, init: RequestInit = {}) {
  const token = await ensureToken();
  if (!token) {
    throw {
      code: "val_session_unavailable",
      message: "Open and sign in to Val.",
      status: 503,
    };
  }
  const response = await fetch(`${VAL_ORIGIN}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    if (response.status === 401) await setSessionToken("");
    const error = relayError(
      body,
      response.status === 429 ? "rate_limit_exceeded" : "val_upstream_error",
    );
    error.status = response.status;
    throw error;
  }
  return body as Record<string, unknown>;
}

async function getModels(force = false) {
  if (!force && modelCache && modelCache.expiresAt > Date.now())
    return modelCache.models;
  const body = await valFetch("/api/models");
  const rawModels = Array.isArray(body)
    ? body
    : Array.isArray(body.data)
      ? body.data
      : null;
  if (!rawModels) {
    throw {
      code: "val_incompatible",
      message: "Val's /api/models response no longer has the expected shape.",
      status: 503,
    };
  }
  const models = rawModels
    .filter((model): model is Record<string, unknown> =>
      Boolean(model && typeof model === "object"),
    )
    .filter((model) => typeof model.id === "string")
    .map((model) => model as ValModel);
  modelCache = { expiresAt: Date.now() + 60_000, models };
  return models;
}

async function verifyValCompatibility() {
  try {
    await getModels(true);
    updateStatus({ compatible: true, lastError: undefined });
  } catch (error) {
    const normalized = relayError(error, "val_incompatible");
    updateStatus({ compatible: false, lastError: normalized.message });
  }
}

async function connectBridge() {
  if (bridgeReconnectTimer) {
    clearTimeout(bridgeReconnectTimer);
    bridgeReconnectTimer = undefined;
  }
  const { secret, url } = await getBridgeSettings();
  if (!secret) {
    cancelActiveRelays();
    const socket = bridgeSocket;
    bridgeSocket = null;
    socket?.close();
    bridgeAuthenticated = false;
    clientApiKey = "";
    companionNetworkScope = "unknown";
    companionClientIpAllowlist = false;
    updateBadge();
    return;
  }
  cancelActiveRelays();
  const previousSocket = bridgeSocket;
  bridgeSocket = null;
  previousSocket?.close();
  bridgeAuthenticated = false;
  clientApiKey = "";
  try {
    const response = await fetch(`${url}/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) {
      companionNetworkScope = "unknown";
      companionClientIpAllowlist = false;
      updateBadge();
      scheduleBridgeReconnect();
      return;
    }
    const health = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    companionNetworkScope =
      health.network_scope === "lan" || health.network_scope === "loopback"
        ? health.network_scope
        : "unknown";
    companionClientIpAllowlist = health.client_ip_allowlist === true;
  } catch {
    companionNetworkScope = "unknown";
    companionClientIpAllowlist = false;
    updateBadge();
    scheduleBridgeReconnect();
    return;
  }
  const websocketUrl = `${url.replace("http://", "ws://")}/bridge/ws`;
  const socket = new WebSocket(websocketUrl);
  bridgeSocket = socket;

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "bridge.auth",
        protocolVersion: PROTOCOL_VERSION,
        extensionId: chrome.runtime.id,
        secret,
      } satisfies ExtensionToServerMessage),
    );
  });
  socket.addEventListener("message", (event) => {
    if (bridgeSocket !== socket) return;
    let message: ServerToExtensionMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerToExtensionMessage;
    } catch {
      socket.close();
      return;
    }
    void handleBridgeMessage(message);
  });
  socket.addEventListener("close", () => {
    if (bridgeSocket !== socket) return;
    cancelActiveRelays();
    bridgeAuthenticated = false;
    clientApiKey = "";
    companionNetworkScope = "unknown";
    companionClientIpAllowlist = false;
    updateBadge();
    scheduleBridgeReconnect();
  });
  socket.addEventListener("error", () => {
    if (bridgeSocket === socket) {
      bridgeAuthenticated = false;
      updateBadge();
    }
  });
}

function scheduleBridgeReconnect() {
  if (bridgeReconnectTimer) return;
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = undefined;
    void connectBridge();
  }, bridgeReconnectDelay);
  bridgeReconnectDelay = Math.min(30_000, bridgeReconnectDelay * 2);
}

function reloadExtensionCleanly() {
  if (bridgeReconnectTimer) {
    clearTimeout(bridgeReconnectTimer);
    bridgeReconnectTimer = undefined;
  }
  cancelActiveRelays();
  const socket = bridgeSocket;
  bridgeSocket = null;
  socket?.close();
  const currentValSocket = valSocket;
  valSocket = null;
  currentValSocket?.removeAllListeners();
  currentValSocket?.disconnect();
  chrome.runtime.reload();
}

async function handleBridgeMessage(message: ServerToExtensionMessage) {
  switch (message.type) {
    case "bridge.authenticated":
      if (
        message.protocolVersion !== PROTOCOL_VERSION ||
        typeof message.clientApiKey !== "string" ||
        !message.clientApiKey.startsWith("val-local-") ||
        message.clientApiKey.length > 256
      ) {
        bridgeSocket?.close();
        return;
      }
      bridgeAuthenticated = true;
      clientApiKey = message.clientApiKey;
      bridgeReconnectDelay = 1_000;
      if (message.usageStats) {
        usageStats = newerUsageStats(
          usageStats,
          restoreSessionUsageStats(message.usageStats),
        );
      }
      persistUsageStats();
      sendBridge({ type: "bridge.status", status: extensionStatus });
      updateBadge();
      void checkForUpdates();
      requestAutomaticOpenCodeConfig();
      break;
    case "bridge.ping":
      sendBridge({ type: "bridge.pong", timestamp: message.timestamp });
      break;
    case "bridge.reload":
      reloadExtensionCleanly();
      break;
    case "relay.request":
      void handleRelayRequest(message.id, message.request);
      updateBadge();
      break;
    case "relay.cancel":
      void cancelRelay(message.id);
      break;
  }
}

async function handleRelayRequest(id: string, request: RelayRequest) {
  try {
    await relayLifecycles.run(id, async (signal) => {
      if (request.kind === "models") {
        const models = await getModels();
        throwIfRelayCancelled(signal);
        sendBridge({ type: "relay.done", id, result: { models } });
        return;
      }
      if (request.kind === "openai.http") {
        await startOpenAIHttp(id, request, signal);
        return;
      }
      if (request.kind === "responses") {
        await startResponses(id, request, signal);
        return;
      }
      await startCompletion(id, request, signal);
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    sendBridge({ type: "relay.error", id, error: relayError(error) });
  } finally {
    updateBadge();
  }
}

async function startOpenAIHttp(
  requestId: string,
  request: RelayOpenAIHttpRequest,
  signal: AbortSignal,
) {
  const token = await ensureToken();
  throwIfRelayCancelled(signal);
  if (!token) {
    sendBridge({
      type: "relay.error",
      id: requestId,
      error: {
        code: "val_session_unavailable",
        message: "Open and sign in to Val.",
        status: 503,
      },
    });
    return;
  }

  const url = valOpenAIHttpUrl(request.path, request.query ?? "");
  if (url.origin !== VAL_ORIGIN || !url.pathname.startsWith("/openai/v1/")) {
    throw new Error("Invalid OpenAI relay URL.");
  }
  const headers = openAIHttpRequestHeaders(request.headers, token);
  const canHaveBody = request.method !== "GET" && request.method !== "HEAD";
  const body =
    canHaveBody && request.body?.encoding === "base64"
      ? base64ToBytes(request.body.data)
      : undefined;
  const generation = openAIHttpGeneration(request);
  let statsSettled = false;
  let usageCapture: OpenAIHttpUsageCapture | undefined;
  const settleHttpRequest = (
    outcome: UsageOutcome,
    usage?: Record<string, unknown>,
    reasoningSummaryAvailable = false,
  ) => {
    if (!generation || statsSettled) return;
    statsSettled = true;
    usageStats = settleUsageRequest(
      usageStats,
      usage,
      outcome,
      Date.now(),
      generation.model,
      { reasoningSummaryAvailable },
    );
    persistUsageStats();
  };
  if (generation) recordPendingRequest();

  sendBridge({
    type: "relay.accepted",
    id: requestId,
    accepted: {},
  });

  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal,
    });
    if (response.status === 401) await setSessionToken("");
    usageCapture = generation
      ? new OpenAIHttpUsageCapture(
          response.headers.get("content-type"),
          response.status,
          generation.stream,
        )
      : undefined;

    sendBridge({
      type: "relay.event",
      id: requestId,
      event: {
        kind: "http.response",
        status: response.status,
        headers: openAIHttpResponseHeaders(response.headers),
      },
    });

    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        throwIfRelayCancelled(signal);
        if (value.length > 0) {
          usageCapture?.push(value);
          sendBridge({
            type: "relay.event",
            id: requestId,
            event: {
              kind: "http.chunk",
              encoding: "base64",
              data: bytesToBase64(value),
            },
          });
        }
      }
    }
    const captured = usageCapture?.finish();
    if (captured) {
      settleHttpRequest(
        captured.outcome,
        captured.usage,
        captured.reasoningSummaryAvailable,
      );
    } else {
      settleHttpRequest(response.ok ? "completed" : "failed");
    }
    sendBridge({ type: "relay.done", id: requestId, result: {} });
  } catch (error) {
    const cancelled =
      (error instanceof DOMException && error.name === "AbortError") ||
      signal.aborted;
    settleHttpRequest(cancelled ? "cancelled" : "failed");
    throw error;
  }
}

async function startResponses(
  requestId: string,
  request: RelayResponsesRequest,
  signal: AbortSignal,
) {
  const token = await ensureToken();
  throwIfRelayCancelled(signal);
  if (!token) {
    sendBridge({
      type: "relay.error",
      id: requestId,
      error: {
        code: "val_session_unavailable",
        message: "Open and sign in to Val.",
        status: 503,
      },
    });
    return;
  }

  recordPendingRequest();
  let usage: Record<string, unknown> | undefined;
  let reasoningSummaryAvailable = false;
  let statsSettled = false;
  const settleResponseRequest = (outcome: UsageOutcome) => {
    if (statsSettled) return;
    statsSettled = true;
    usageStats = settleUsageRequest(
      usageStats,
      usage,
      outcome,
      Date.now(),
      request.model,
      { reasoningSummaryAvailable },
    );
    persistUsageStats();
  };
  const captureUsage = (value: unknown) => {
    const details = responseUsageDetails(value);
    usage = details.usage;
    reasoningSummaryAvailable = details.reasoningSummaryAvailable;
  };
  let terminalEvent:
    | "response.completed"
    | "response.failed"
    | "response.incomplete"
    | undefined;
  const relaySseEvent = (event: ParsedSseEvent) => {
    if (event.data.trim() === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      throw {
        code: "val_invalid_response_stream",
        message: "Val returned malformed Responses stream data.",
        status: 502,
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw {
        code: "val_invalid_response_stream",
        message: "Val returned a non-object Responses stream event.",
        status: 502,
      };
    }
    const data = parsed as Record<string, unknown>;
    const eventType =
      event.eventType === "message" && typeof data.type === "string"
        ? data.type
        : event.eventType;
    if (
      eventType === "response.completed" ||
      eventType === "response.failed" ||
      eventType === "response.incomplete"
    ) {
      terminalEvent = eventType;
      captureUsage(data);
    }
    sendBridge({
      type: "relay.event",
      id: requestId,
      event: {
        kind: "sse",
        eventType,
        data: data as JsonObject,
      },
    });
  };

  sendBridge({
    type: "relay.accepted",
    id: requestId,
    accepted: {},
  });

  const isStreaming = request.body.stream === true;
  const headers = openAIHttpRequestHeaders(request.headers, token);
  headers["content-type"] = "application/json";
  if (isStreaming) {
    headers.accept = "text/event-stream";
  }

  try {
    const response = await fetch(`${VAL_ORIGIN}/openai/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal,
    });

    if (!response.ok) {
      if (response.status === 401) await setSessionToken("");
      const text = (await response.text()).slice(0, 4_096);
      let detail: string | undefined;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const error =
          parsed.error &&
          typeof parsed.error === "object" &&
          !Array.isArray(parsed.error)
            ? (parsed.error as Record<string, unknown>)
            : undefined;
        detail =
          typeof error?.message === "string"
            ? error.message
            : typeof parsed.detail === "string"
              ? parsed.detail
              : text;
      } catch {
        detail = text;
      }
      sendBridge({
        type: "relay.error",
        id: requestId,
        error: {
          code:
            response.status === 429
              ? "rate_limit_exceeded"
              : "val_upstream_error",
          message: detail ?? `Val returned ${response.status}.`,
          status: response.status,
        },
      });
      settleResponseRequest("failed");
      return;
    }

    if (!isStreaming) {
      const parsed = (await response.json()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw {
          code: "val_invalid_response",
          message: "Val returned an invalid Responses object.",
          status: 502,
        };
      }
      const body = parsed as Record<string, unknown>;
      const status = body.status;
      const eventType =
        status === "failed"
          ? "response.failed"
          : status === "incomplete"
            ? "response.incomplete"
            : status === "completed"
              ? "response.completed"
              : undefined;
      if (!eventType) {
        throw {
          code: "val_incomplete_response",
          message:
            "Val ended a non-streaming response without a terminal status.",
          status: 502,
        };
      }
      captureUsage(body);
      sendBridge({
        type: "relay.event",
        id: requestId,
        event: {
          kind: "sse",
          eventType,
          data: body as JsonObject,
        },
      });
      settleResponseRequest(
        eventType === "response.completed" ? "completed" : "failed",
      );
      sendBridge({ type: "relay.done", id: requestId, result: {} });
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw {
        code: "val_invalid_response_stream",
        message: "Val returned an empty Responses stream.",
        status: 502,
      };
    }

    const decoder = new TextDecoder();
    const parser = new SseParser();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(
        decoder.decode(value, { stream: true }),
      )) {
        relaySseEvent(event);
      }
    }
    for (const event of parser.finish(decoder.decode())) {
      relaySseEvent(event);
    }

    if (!terminalEvent) {
      throw {
        code: "val_incomplete_response_stream",
        message: "Val ended the Responses stream before a terminal event.",
        status: 502,
      };
    }
    settleResponseRequest(
      terminalEvent === "response.completed" ? "completed" : "failed",
    );
    sendBridge({
      type: "relay.done",
      id: requestId,
      result: {},
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      settleResponseRequest("cancelled");
      return;
    }
    settleResponseRequest("failed");
    sendBridge({
      type: "relay.error",
      id: requestId,
      error: relayError(error),
    });
  } finally {
    // RelayLifecycleRegistry owns signal cleanup.
  }
}

function bridgeOwned(chat: Record<string, unknown>) {
  const meta = chat.meta;
  return (
    meta &&
    typeof meta === "object" &&
    (meta as Record<string, unknown>).source === "val-openai-bridge"
  );
}

async function startCompletion(
  requestId: string,
  request: RelayCompletionRequest,
  signal: AbortSignal,
) {
  const socket = await ensureValSocket();
  throwIfRelayCancelled(signal);
  if (!socket.id) {
    throw {
      code: "val_socket_unavailable",
      message: "Val's chat session has no ID.",
      status: 503,
    };
  }

  const models = await getModels();
  throwIfRelayCancelled(signal);
  const modelItem = models.find((model) => model.id === request.model);
  if (!modelItem) {
    throw {
      code: "model_not_found",
      message: `Val does not currently expose the model "${request.model}".`,
      status: 404,
    };
  }
  const sessionId = socket.id;
  if (!sessionId) {
    throw {
      code: "val_socket_unavailable",
      message: "Val's chat session disconnected before submission.",
      status: 503,
    };
  }

  let completionMessages: OpenAIMessage[] = request.messages;
  let existingChat: Record<string, unknown> | undefined;
  let chatId = "local";
  let exposedChatId: string | undefined;
  const storedPersistence =
    request.persistence.mode === "stored" ? request.persistence : undefined;
  const stored = Boolean(storedPersistence);

  if (storedPersistence?.chatId) {
    const record = await valFetch(
      `/api/v1/chats/${encodeURIComponent(storedPersistence.chatId)}`,
    );
    throwIfRelayCancelled(signal);
    existingChat =
      record.chat && typeof record.chat === "object"
        ? (record.chat as Record<string, unknown>)
        : record;
    if (!bridgeOwned(existingChat)) {
      throw {
        code: "chat_not_owned",
        message: "The requested Val chat was not created by this bridge.",
        status: 409,
      };
    }
    chatId = storedPersistence.chatId;
    exposedChatId = chatId;
    if (storedPersistence.appendToExisting) {
      completionMessages = [
        ...storedMessagesToOpenAI(existingChat.messages),
        ...request.messages,
      ];
    }
  }

  const built = buildValHistory(completionMessages, request.model);
  const previousMeta =
    existingChat?.meta && typeof existingChat.meta === "object"
      ? (existingChat.meta as Record<string, unknown>)
      : {};
  const chatObject: Record<string, unknown> = {
    ...(existingChat ?? {}),
    title: existingChat?.title ?? storedPersistence?.title ?? "API Chat",
    models: [request.model],
    params: request.parameters ?? {},
    history: built.history,
    messages: built.messages,
    files: [],
    tags: Array.isArray(existingChat?.tags) ? existingChat.tags : [],
    timestamp: existingChat?.timestamp ?? Date.now(),
    meta: {
      ...previousMeta,
      source: "val-openai-bridge",
      version: 1,
    },
  };

  if (storedPersistence && !storedPersistence.chatId) {
    throwIfRelayCancelled(signal);
    const created = await valFetch("/api/v1/chats/new", {
      method: "POST",
      body: JSON.stringify({ chat: chatObject }),
    });
    throwIfRelayCancelled(signal);
    const createdId =
      typeof created.id === "string"
        ? created.id
        : created.chat &&
            typeof created.chat === "object" &&
            typeof (created.chat as Record<string, unknown>).id === "string"
          ? String((created.chat as Record<string, unknown>).id)
          : "";
    if (!createdId) {
      throw {
        code: "chat_create_failed",
        message: "Val created a chat without returning its ID.",
        status: 502,
      };
    }
    chatId = createdId;
    exposedChatId = createdId;
  } else if (stored) {
    throwIfRelayCancelled(signal);
    await valFetch(`/api/v1/chats/${encodeURIComponent(chatId)}`, {
      method: "POST",
      body: JSON.stringify({ chat: chatObject }),
    });
    throwIfRelayCancelled(signal);
  }

  throwIfRelayCancelled(signal);
  const pending: PendingCompletion = {
    requestId,
    request,
    sessionId,
    chatId,
    ...(exposedChatId ? { exposedChatId } : {}),
    stored,
    history: built,
    chatObject,
    modelItem: modelItem as Record<string, unknown>,
    assistantContent: "",
    reasoningContent: "",
    toolCalls: new Map(),
    finished: false,
    cancelRequested: false,
    statsSettled: false,
  };
  pendingByRequest.set(requestId, pending);
  pendingByMessage.set(
    pendingMessageKey(sessionId, chatId, built.assistantMessageId),
    pending,
  );
  recordPendingRequest();

  sendBridge({
    type: "relay.accepted",
    id: requestId,
    accepted: {
      ...(exposedChatId ? { chatId: exposedChatId } : {}),
      messageId: built.assistantMessageId,
    },
  });

  try {
    const result = await valFetch("/api/chat/completions", {
      method: "POST",
      body: JSON.stringify(
        completionPayload(
          request,
          modelItem as Record<string, unknown>,
          sessionId,
          chatId,
          built.assistantMessageId,
          completionMessages,
        ),
      ),
    });

    const taskId =
      typeof result.task_id === "string" ? result.task_id : undefined;
    if (pending.cancelRequested) {
      if (taskId) await stopValTask(taskId);
      cleanupPending(pending);
      return;
    }
    if (pending.finished) return;
    if (result.error) {
      throw result.error;
    }
    if (taskId) {
      pending.taskId = taskId;
      sendBridge({
        type: "relay.accepted",
        id: requestId,
        accepted: {
          taskId,
          ...(exposedChatId ? { chatId: exposedChatId } : {}),
          messageId: built.assistantMessageId,
        },
      });
    }
    if (Array.isArray(result.choices)) {
      const bufferClientTools =
        Boolean(request.tools?.length) && request.toolChoice !== "none";
      applyOpenAIData(pending, result, {
        captureToolCalls: !bufferClientTools,
      });
      if (!bufferClientTools) {
        sendBridge({
          type: "relay.event",
          id: requestId,
          event: { kind: "openai", data: result as JsonObject },
        });
      }
      await finishCompletion(pending);
    } else if (!taskId) {
      throw {
        code: "invalid_completion_response",
        message: "Val returned neither a completion nor a background task ID.",
        status: 502,
      };
    }
  } catch (error) {
    if (pending.cancelRequested) cleanupPending(pending);
    else failCompletion(pending, relayError(error));
  }
}

function findPendingForEvent(event: Record<string, unknown>) {
  const data =
    event.data && typeof event.data === "object"
      ? (event.data as Record<string, unknown>)
      : {};
  const nested =
    data.data && typeof data.data === "object"
      ? (data.data as Record<string, unknown>)
      : {};
  const sessionId = String(
    event.session_id ??
      data.session_id ??
      nested.session_id ??
      valSocket?.id ??
      "",
  );
  const chatId = String(event.chat_id ?? data.chat_id ?? nested.chat_id ?? "");
  const messageId = String(
    event.message_id ?? data.message_id ?? nested.message_id ?? nested.id ?? "",
  );
  return pendingByMessage.get(pendingMessageKey(sessionId, chatId, messageId));
}

async function handleValChatEvent(
  rawEvent: unknown,
  callback?: (value: unknown) => void,
) {
  if (!rawEvent || typeof rawEvent !== "object") return;
  const event = rawEvent as Record<string, unknown>;
  const pending = findPendingForEvent(event);
  if (!pending || pending.finished) return;
  const bufferClientTools =
    Boolean(pending.request.tools?.length) &&
    pending.request.toolChoice !== "none";

  const envelope =
    event.data && typeof event.data === "object"
      ? (event.data as Record<string, unknown>)
      : {};
  const type = String(envelope.type ?? "");
  const rawData = envelope.data;
  let data: Record<string, unknown> = {};
  if (rawData && typeof rawData === "object") {
    data = rawData as Record<string, unknown>;
  } else if (typeof rawData === "string" && rawData !== "[DONE]") {
    try {
      const parsed = JSON.parse(rawData) as unknown;
      if (parsed && typeof parsed === "object") {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = { content: rawData };
    }
  }

  const allowedClientToolNames = (pending.request.tools ?? []).map(
    (tool) => tool.function.name,
  );
  if (
    type === "tool_request_permission" &&
    isBridgeClientToolEvent(data, allowedClientToolNames)
  ) {
    callback?.(true);
    return;
  }

  if (
    type === "execute:tool" ||
    (type === "execute" && typeof data.name === "string")
  ) {
    callback?.(false);
    try {
      pending.interceptedClientToolCalls = [
        parseClientToolExecution(data, allowedClientToolNames),
      ];
      pending.assistantContent = "";
      pending.cancelRequested = true;
      if (pending.taskId) {
        await stopValTask(pending.taskId);
      }
      await finishCompletion(pending);
    } catch (error) {
      failCompletion(pending, relayError(error, "val_native_tool_selected"));
    }
    return;
  }

  if (
    [
      "confirmation",
      "input",
      "structuredInput",
      "tool_request_permission",
      "execute",
    ].includes(type)
  ) {
    callback?.(false);
    failCompletion(pending, {
      code: "interactive_val_tool_unsupported",
      message: `Val requested unsupported interactive event "${type}"${typeof data.name === "string" ? ` for "${data.name}"` : ""}; it cannot be relayed as an unattended API call.`,
      status: 400,
    });
    return;
  }

  if (type === "chat:completion") {
    if (rawData === "[DONE]") {
      await finishCompletion(pending);
      return;
    }
    const standaloneReasoning = reasoningTextFromRecord(data);
    if (standaloneReasoning) {
      pending.reasoningContent = mergeStreamFragment(
        pending.reasoningContent,
        standaloneReasoning,
      );
      if (!bufferClientTools) {
        sendBridge({
          type: "relay.event",
          id: pending.requestId,
          event: { kind: "openai", data: data as JsonObject },
        });
      }
    }
    if (typeof data.content === "string") {
      pending.assistantContent = data.content;
      if (!bufferClientTools) {
        sendBridge({
          type: "relay.event",
          id: pending.requestId,
          event: { kind: "replace", content: data.content },
        });
      }
    }
    if (Array.isArray(data.choices)) {
      applyOpenAIData(pending, data, { captureToolCalls: !bufferClientTools });
      if (!bufferClientTools) {
        sendBridge({
          type: "relay.event",
          id: pending.requestId,
          event: { kind: "openai", data: data as JsonObject },
        });
      }
    } else if (data.usage && typeof data.usage === "object") {
      pending.usage = data.usage as JsonObject;
      if (!bufferClientTools) {
        sendBridge({
          type: "relay.event",
          id: pending.requestId,
          event: { kind: "usage", usage: data.usage as JsonObject },
        });
      }
    }
    if (data.error) {
      failCompletion(pending, relayError(data.error));
    } else if (data.done === true) {
      await finishCompletion(pending);
    }
  } else if (type === "chat:completion:done" || type === "done") {
    await finishCompletion(pending);
  } else if (/(?:reasoning|thinking)/i.test(type)) {
    const reasoningRecord = { type, ...data };
    const reasoning = reasoningTextFromRecord(reasoningRecord);
    if (!reasoning) return;
    pending.reasoningContent = mergeStreamFragment(
      pending.reasoningContent,
      reasoning,
    );
    if (!bufferClientTools) {
      sendBridge({
        type: "relay.event",
        id: pending.requestId,
        event: { kind: "openai", data: reasoningRecord as JsonObject },
      });
    }
  } else if (type === "chat:message:delta" || type === "message") {
    const reasoning = reasoningTextFromRecord(data);
    if (reasoning) {
      pending.reasoningContent = mergeStreamFragment(
        pending.reasoningContent,
        reasoning,
      );
    }
    const content = assistantTextFromContent(data.content);
    pending.assistantContent += content;
    if (!bufferClientTools) {
      if (reasoning) {
        sendBridge({
          type: "relay.event",
          id: pending.requestId,
          event: { kind: "openai", data: data as JsonObject },
        });
      }
      sendBridge({
        type: "relay.event",
        id: pending.requestId,
        event: { kind: "delta", content },
      });
    }
  } else if (type === "chat:message" || type === "replace") {
    const reasoning = reasoningTextFromRecord(data);
    if (reasoning) {
      pending.reasoningContent = mergeStreamFragment(
        pending.reasoningContent,
        reasoning,
      );
    }
    const content = assistantTextFromContent(data.content);
    pending.assistantContent = content;
    if (!bufferClientTools) {
      if (reasoning) {
        sendBridge({
          type: "relay.event",
          id: pending.requestId,
          event: { kind: "openai", data: data as JsonObject },
        });
      }
      sendBridge({
        type: "relay.event",
        id: pending.requestId,
        event: { kind: "replace", content },
      });
    }
  } else if (type === "status" || type === "source" || type === "citation") {
    if (type === "status") {
      const reasoning = reasoningTextFromStatus(data);
      if (reasoning) {
        pending.reasoningContent = mergeStreamFragment(
          pending.reasoningContent,
          reasoning,
        );
      }
    }
    if (!bufferClientTools) {
      sendBridge({
        type: "relay.event",
        id: pending.requestId,
        event: { kind: "status", data: { type, ...data } as JsonObject },
      });
    }
  }
}

function applyOpenAIData(
  pending: PendingCompletion,
  data: Record<string, unknown>,
  options: { captureToolCalls?: boolean } = {},
) {
  if (data.usage && typeof data.usage === "object") {
    pending.usage = data.usage as JsonObject;
  }
  const choices = Array.isArray(data.choices) ? data.choices.slice(0, 1) : [];
  for (const rawChoice of choices) {
    if (!rawChoice || typeof rawChoice !== "object") continue;
    const choice = rawChoice as Record<string, unknown>;
    const delta =
      choice.delta && typeof choice.delta === "object"
        ? (choice.delta as Record<string, unknown>)
        : undefined;
    const message =
      choice.message && typeof choice.message === "object"
        ? (choice.message as Record<string, unknown>)
        : undefined;
    const content = assistantTextFromContent(
      delta?.content ?? message?.content,
    );
    const reasoning =
      reasoningTextFromRecord(delta) ||
      reasoningTextFromRecord(message) ||
      reasoningTextFromRecord(choice);
    if (reasoning) {
      pending.reasoningContent = mergeStreamFragment(
        pending.reasoningContent,
        reasoning,
      );
    }
    if (content) {
      if (message) pending.assistantContent = content;
      else {
        pending.assistantContent = mergeStreamFragment(
          pending.assistantContent,
          content,
        );
      }
    }
    let toolCalls = (delta?.tool_calls ?? message?.tool_calls) as unknown;
    const legacyFunctionCall = delta?.function_call ?? message?.function_call;
    if (
      !Array.isArray(toolCalls) &&
      legacyFunctionCall &&
      typeof legacyFunctionCall === "object"
    ) {
      toolCalls = [
        {
          index: 0,
          type: "function",
          function: legacyFunctionCall,
        },
      ];
    }
    if (options.captureToolCalls === false) continue;
    if (!Array.isArray(toolCalls)) continue;
    for (const [fallbackIndex, rawTool] of toolCalls.entries()) {
      if (!rawTool || typeof rawTool !== "object") continue;
      const tool = rawTool as Record<string, unknown>;
      const index = resolvePendingToolIndex(pending, tool, fallbackIndex);
      const fn =
        tool.function && typeof tool.function === "object"
          ? (tool.function as Record<string, unknown>)
          : {};
      const current = pending.toolCalls.get(index) ?? {
        id:
          typeof tool.id === "string"
            ? tool.id
            : `call_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (typeof tool.id === "string") current.id = tool.id;
      if (typeof fn.name === "string") {
        current.function.name = mergeStreamFragment(
          current.function.name,
          fn.name,
        );
      }
      if (typeof fn.arguments === "string") {
        mergeArgumentFragment(current, fn.arguments);
      }
      pending.toolCalls.set(index, current);
    }
  }
}

function resolvePendingToolIndex(
  pending: PendingCompletion,
  tool: Record<string, unknown>,
  fallbackIndex: number,
) {
  const id = typeof tool.id === "string" && tool.id ? tool.id : undefined;
  if (id) {
    for (const [index, existing] of pending.toolCalls) {
      if (existing.id === id) return index;
    }
  }

  let index = typeof tool.index === "number" ? tool.index : fallbackIndex;
  const existing = pending.toolCalls.get(index);
  if (id && existing && existing.id !== id) {
    index = 0;
    while (pending.toolCalls.has(index)) index += 1;
  }
  return index;
}

function clientToolCallRequired(request: RelayCompletionRequest) {
  if (request.toolChoice === "required") return true;
  if (
    request.toolChoice &&
    typeof request.toolChoice === "object" &&
    !Array.isArray(request.toolChoice)
  ) {
    const choice = request.toolChoice as Record<string, unknown>;
    return Boolean(
      choice.function &&
      typeof choice.function === "object" &&
      !Array.isArray(choice.function) &&
      typeof (choice.function as Record<string, unknown>).name === "string",
    );
  }
  return false;
}

function emitBufferedClientToolResult(pending: PendingCompletion) {
  const tools =
    pending.request.toolChoice === "none" ? [] : (pending.request.tools ?? []);
  if (tools.length === 0) return;

  const separated = splitValReasoningMarkup(pending.assistantContent);
  pending.assistantContent = separated.content;
  pending.reasoningContent = mergeStreamFragment(
    pending.reasoningContent,
    separated.reasoning,
  );
  const nativeToolTraces = findValNativeToolTraces(pending.assistantContent);
  if (
    nativeToolTraces.length > 0 &&
    !pending.interceptedClientToolCalls?.length
  ) {
    const selectedNames = [
      ...new Set(
        nativeToolTraces
          .map((trace) => trace.name ?? trace.internalId)
          .filter((name): name is string => Boolean(name)),
      ),
    ];
    throw {
      code: "val_native_tool_selected",
      message:
        selectedNames.length > 0
          ? `Val selected its internal tool ${selectedNames.map((name) => `"${name}"`).join(", ")} instead of an API client tool.`
          : "Val selected an internal tool instead of an API client tool.",
      status: 502,
    };
  }
  const parsed = pending.interceptedClientToolCalls?.length
    ? {
        content: "",
        toolCalls: pending.interceptedClientToolCalls,
      }
    : resolveClientToolResponse(
        pending.assistantContent,
        tools.map((tool) => tool.function.name),
        pending.request.toolChoice,
      );
  if (
    parsed.toolCalls.length === 0 &&
    clientToolCallRequired(pending.request)
  ) {
    throw new Error(
      "Val did not return the required client-side function call.",
    );
  }

  pending.assistantContent = parsed.content;
  pending.toolCalls.clear();
  for (const [index, toolCall] of parsed.toolCalls.entries()) {
    pending.toolCalls.set(index, {
      id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    });
  }

  const toolCalls = [...pending.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, tool]) => ({
      id: tool.id,
      index,
      type: tool.type,
      function: {
        name: tool.function.name,
        arguments: tool.function.arguments,
      },
    }));
  sendBridge({
    type: "relay.event",
    id: pending.requestId,
    event: {
      kind: "openai",
      data: {
        choices: [
          {
            index: 0,
            delta: {
              ...(pending.reasoningContent
                ? { reasoning_content: pending.reasoningContent }
                : {}),
              ...(toolCalls.length > 0
                ? { tool_calls: toolCalls }
                : { content: pending.assistantContent }),
            },
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        ...(pending.usage ? { usage: pending.usage } : {}),
      },
    },
  });
}

async function finishCompletion(pending: PendingCompletion) {
  if (pending.finished) return;
  pending.finished = true;
  updateBadge();
  try {
    emitBufferedClientToolResult(pending);
  } catch (error) {
    settlePendingRequest(pending, "failed");
    cleanupPending(pending);
    const normalized = relayError(error, "invalid_tool_bridge_response");
    sendBridge({
      type: "relay.error",
      id: pending.requestId,
      error: normalized,
    });
    return;
  }

  const assistant =
    pending.history.history.messages[pending.history.assistantMessageId];
  if (assistant) {
    assistant.content = pending.assistantContent;
    assistant.done = true;
    if (pending.usage) assistant.usage = pending.usage;
    if (pending.toolCalls.size > 0) {
      assistant.tool_calls = [...pending.toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, tool]) => ({
          id: tool.id,
          type: tool.type,
          index,
          function: {
            name: tool.function.name,
            arguments: collapseRepeatedJson(tool.function.arguments),
          },
        }));
    }
  }
  pending.history.messages = Object.values(pending.history.history.messages);
  pending.chatObject.history = pending.history.history;
  pending.chatObject.messages = pending.history.messages;

  try {
    await valFetch("/api/chat/completed", {
      method: "POST",
      body: JSON.stringify({
        model: pending.request.model,
        messages: pending.history.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
          ...(message.usage ? { usage: message.usage } : {}),
        })),
        model_item: pending.modelItem,
        chat_id: pending.chatId,
        session_id: pending.sessionId,
        id: pending.history.assistantMessageId,
      }),
    });
    if (pending.stored) {
      await valFetch(`/api/v1/chats/${encodeURIComponent(pending.chatId)}`, {
        method: "POST",
        body: JSON.stringify({ chat: pending.chatObject }),
      });
    }
  } catch (error) {
    if (pending.stored) {
      settlePendingRequest(pending, "failed");
      cleanupPending(pending);
      sendBridge({
        type: "relay.error",
        id: pending.requestId,
        error: {
          ...relayError(error, "persistence_failed"),
          code: "persistence_failed",
          message:
            "Val generated a response but its visible chat history could not be updated.",
        },
      });
      return;
    }
  }

  settlePendingRequest(pending, "completed");
  cleanupPending(pending);
  sendBridge({
    type: "relay.done",
    id: pending.requestId,
    result: {
      ...(pending.exposedChatId ? { chatId: pending.exposedChatId } : {}),
      content: pending.assistantContent,
      ...(pending.toolCalls.size > 0
        ? {
            toolCalls: [...pending.toolCalls.entries()]
              .sort(([left], [right]) => left - right)
              .map(
                ([index, tool]) =>
                  ({
                    id: tool.id,
                    type: tool.type,
                    index,
                    function: {
                      name: tool.function.name,
                      arguments: collapseRepeatedJson(tool.function.arguments),
                    },
                  }) as OpenAIToolCall,
              ),
          }
        : {}),
      ...(pending.usage ? { usage: pending.usage } : {}),
    },
  });
}

function failCompletion(pending: PendingCompletion, error: RelayError) {
  if (pending.finished) return;
  pending.finished = true;
  updateBadge();
  settlePendingRequest(pending, "failed");
  cleanupPending(pending);
  sendBridge({ type: "relay.error", id: pending.requestId, error });
}

function cleanupPending(pending: PendingCompletion) {
  pendingByRequest.delete(pending.requestId);
  pendingByMessage.delete(
    pendingMessageKey(
      pending.sessionId,
      pending.chatId,
      pending.history.assistantMessageId,
    ),
  );
}

async function cancelRelay(requestId: string) {
  relayLifecycles.cancel(requestId);
  const pending = pendingByRequest.get(requestId);
  if (pending && !pending.finished) {
    pending.cancelRequested = true;
    pending.finished = true;
    updateBadge();
    settlePendingRequest(pending, "cancelled");
    if (pending.taskId) {
      await stopValTask(pending.taskId);
      cleanupPending(pending);
    }
    return;
  }
}

async function stopValTask(taskId: string) {
  try {
    await valFetch(`/api/tasks/stop/${encodeURIComponent(taskId)}`, {
      method: "POST",
    });
  } catch {
    // The local client has already gone away; cancellation is best effort.
  }
}

async function pairBridge(code: string, rawUrl: string) {
  if (!/^\d{6}$/.test(code)) {
    throw new Error("Enter the six-digit code shown by the companion.");
  }
  const url = normalizeBridgeUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(`${url}/bridge/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        extensionId: chrome.runtime.id,
        protocolVersion: PROTOCOL_VERSION,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The companion did not respond within ten seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let body: unknown = {};
  try {
    body = JSON.parse(responseText) as unknown;
  } catch {
    // The status code below supplies a safe pairing error.
  }
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const errorRecord =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : {};
  if (
    !response.ok ||
    typeof record.bridgeSecret !== "string" ||
    typeof record.protocolVersion !== "number"
  ) {
    throw new Error(
      typeof errorRecord.message === "string"
        ? errorRecord.message
        : "Pairing failed.",
    );
  }
  const pairResponse = record as PairResponse;
  if (pairResponse.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      "The extension and companion protocol versions do not match.",
    );
  }
  await chrome.storage.local.set({
    [BRIDGE_SECRET_KEY]: pairResponse.bridgeSecret,
    [BRIDGE_URL_KEY]: url,
  });
  await connectBridge();
}

async function performOpenCodeConfiguration(): Promise<OpenCodeConfigureResult> {
  const { secret, url } = await getBridgeSettings();
  if (!secret) {
    throw new Error("Pair the extension with the companion first.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`${url}/bridge/configure-opencode`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenCode configuration timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const error =
    body.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : {};
  if (
    !response.ok ||
    body.configured !== true ||
    typeof body.models_configured !== "number" ||
    typeof body.updated !== "boolean"
  ) {
    throw new Error(
      typeof error.message === "string"
        ? error.message
        : "The companion could not configure OpenCode.",
    );
  }
  return {
    modelsConfigured: body.models_configured,
    updated: body.updated,
    backupCreated: body.backup_created === true,
  };
}

async function configureOpenCode() {
  if (openCodeConfigurePromise) return await openCodeConfigurePromise;
  openCodeConfigurePromise = performOpenCodeConfiguration().finally(() => {
    openCodeConfigurePromise = undefined;
  });
  return await openCodeConfigurePromise;
}

async function configureOpenCodeManually() {
  const result = await configureOpenCode();
  await completeOpenCodeAutoConfig(EXTENSION_VERSION);
  return result;
}

async function rotateClientApiKey() {
  const { secret, url } = await getBridgeSettings();
  if (!secret) {
    throw new Error("Pair the extension with the companion first.");
  }
  const response = await fetch(`${url}/bridge/security/rotate-client-key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (
    !response.ok ||
    body.rotated !== true ||
    typeof body.client_api_key !== "string" ||
    !body.client_api_key.startsWith("val-local-")
  ) {
    throw new Error(
      updateErrorMessage(body, "The companion could not rotate the API key."),
    );
  }
  clientApiKey = body.client_api_key;
  return { clientApiKey };
}

async function resetUsageStats() {
  const { secret, url } = await getBridgeSettings();
  if (!secret) {
    throw new Error("Pair the extension with the companion first.");
  }
  const response = await fetch(`${url}/bridge/usage/reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || body.reset !== true || !body.stats) {
    throw new Error(
      updateErrorMessage(body, "The companion could not reset usage totals."),
    );
  }
  usageStats = restoreSessionUsageStats(body.stats);
  persistUsageStats();
  return { reset: true };
}

async function setCompanionNetworkScope(scope: "loopback" | "lan") {
  const { secret, url } = await getBridgeSettings();
  if (!secret) {
    throw new Error("Pair the extension with the companion first.");
  }
  const response = await fetch(`${url}/bridge/network-scope`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scope }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || body.accepted !== true || body.network_scope !== scope) {
    throw new Error(
      updateErrorMessage(
        body,
        "The companion could not change network access.",
      ),
    );
  }
  if (body.restart_scheduled === true) {
    await waitForCompanionToStop(url);
    await chrome.tabs.create({
      url: COMPANION_LAUNCH_URL,
      active: true,
    });
    return { scope, restarting: true };
  }
  companionNetworkScope =
    body.restart_required === true ? companionNetworkScope : scope;
  return {
    scope,
    restarting: false,
    restartRequired: body.restart_required === true,
  };
}

function updateErrorMessage(body: Record<string, unknown>, fallback: string) {
  const error =
    body.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : {};
  return typeof error.message === "string"
    ? error.message
    : typeof body.error === "string"
      ? body.error
      : fallback;
}

async function performUpdateCheck() {
  const { secret, url } = await getBridgeSettings();
  if (!secret) return extensionUpdateStatus;
  const endpoint = new URL("/bridge/update/status", url);
  endpoint.searchParams.set("current_version", EXTENSION_VERSION);
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      updateErrorMessage(body, "The companion could not check for updates."),
    );
  }
  const status = parseCompanionUpdateStatus(body, EXTENSION_VERSION);
  setExtensionUpdateStatus(status);
  return status;
}

async function checkForUpdates(force = false) {
  if (
    !force &&
    extensionUpdateStatus.state !== "unknown" &&
    extensionUpdateStatus.state !== "error" &&
    extensionUpdateStatus.state !== "installing" &&
    extensionUpdateStatus.checkedAt &&
    Date.now() - extensionUpdateStatus.checkedAt < UPDATE_CHECK_MINIMUM_GAP_MS
  ) {
    return extensionUpdateStatus;
  }
  if (updateCheckPromise) return await updateCheckPromise;
  updateCheckPromise = performUpdateCheck()
    .catch((error) => {
      const message =
        error instanceof Error ? error.message : "Update check failed.";
      const status: ExtensionUpdateStatus =
        extensionUpdateStatus.state === "available"
          ? { ...extensionUpdateStatus, message }
          : {
              state: "error",
              currentVersion: EXTENSION_VERSION,
              checkedAt: Date.now(),
              message,
            };
      setExtensionUpdateStatus(status);
      return status;
    })
    .finally(() => {
      updateCheckPromise = undefined;
    });
  return await updateCheckPromise;
}

async function waitForCompanionToStop(url: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/healthz`, {
        cache: "no-store",
        signal: AbortSignal.timeout(750),
      });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The companion did not stop in time for the update.");
}

async function applyAvailableUpdate() {
  const status = await checkForUpdates(true);
  if (status.state === "error") {
    throw new Error(status.message ?? "The update check failed.");
  }
  if (status.state !== "available" || !status.latestVersion) {
    throw new Error("No newer bridge update is currently available.");
  }
  const { secret, url } = await getBridgeSettings();
  if (!secret) {
    throw new Error("Pair the extension with the companion before updating.");
  }

  let accepted = false;
  try {
    await markOpenCodeAutoConfigPending(status.latestVersion);
    const response = await fetch(`${url}/bridge/update/prepare`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ current_version: EXTENSION_VERSION }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (
      !response.ok ||
      body.accepted !== true ||
      body.latest_version !== status.latestVersion
    ) {
      throw new Error(
        updateErrorMessage(body, "The companion could not start the update."),
      );
    }
    accepted = true;
    setExtensionUpdateStatus({
      state: "installing",
      currentVersion: EXTENSION_VERSION,
      latestVersion: status.latestVersion,
      checkedAt: Date.now(),
    });
    await waitForCompanionToStop(url);
    await chrome.tabs.create({
      url: COMPANION_LAUNCH_URL,
      active: true,
    });
    return { latestVersion: status.latestVersion };
  } catch (error) {
    if (accepted) {
      setExtensionUpdateStatus({
        ...status,
        state: "available",
        message:
          error instanceof Error
            ? error.message
            : "The installed updater could not be opened.",
      });
    }
    throw error;
  }
}

async function ensureUpdateAlarm() {
  const alarm = await chrome.alarms.get(UPDATE_ALARM_NAME);
  if (!alarm || alarm.periodInMinutes !== UPDATE_CHECK_INTERVAL_MINUTES) {
    await chrome.alarms.create(UPDATE_ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES,
    });
  }
}

async function popupStatus(): Promise<PopupStatus> {
  const settings = await getBridgeSettings();
  return {
    ...extensionStatus,
    bridgeConnected: bridgeAuthenticated,
    bridgePaired: Boolean(settings.secret),
    bridgeUrl: settings.url,
    networkScope: companionNetworkScope,
    clientIpAllowlist: companionClientIpAllowlist,
    ...(clientApiKey ? { clientApiKey } : {}),
    update: extensionUpdateStatus,
    openCodeAutoConfig: {
      pending: openCodeAutoConfigState?.targetVersion === EXTENSION_VERSION,
      attempts:
        openCodeAutoConfigState?.targetVersion === EXTENSION_VERSION
          ? openCodeAutoConfigState.attempts
          : 0,
      ...(openCodeAutoConfigState?.targetVersion === EXTENSION_VERSION &&
      openCodeAutoConfigState.lastError
        ? { lastError: openCodeAutoConfigState.lastError }
        : {}),
    },
    stats: {
      ...usageStats,
      activeRequests: activeRequestCount(),
    },
  };
}

function isValContentSender(sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    return new URL(sender.url).origin === VAL_ORIGIN;
  } catch {
    return false;
  }
}

function isPopupSender(sender: chrome.runtime.MessageSender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("popup.html")
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (message?.type === TOKEN_MESSAGE && isValContentSender(sender)) {
      await setSessionToken(
        typeof message.token === "string" ? message.token : "",
      );
      return { ok: true };
    }
    if (!isPopupSender(sender)) {
      return {
        ok: false,
        error: "This action is available only from the extension popup.",
      };
    }
    if (message?.type === "POPUP_GET_STATUS") {
      return await popupStatus();
    }
    if (message?.type === "POPUP_RECONNECT_BRIDGE") {
      bridgeReconnectDelay = 1_000;
      await connectBridge();
      return { ok: true };
    }
    if (message?.type === "POPUP_PAIR") {
      await pairBridge(
        String(message.code ?? ""),
        String(message.url ?? DEFAULT_BRIDGE_URL),
      );
      return { ok: true };
    }
    if (message?.type === "POPUP_UNPAIR") {
      await chrome.storage.local.remove(BRIDGE_SECRET_KEY);
      if (bridgeReconnectTimer) {
        clearTimeout(bridgeReconnectTimer);
        bridgeReconnectTimer = undefined;
      }
      const socket = bridgeSocket;
      bridgeSocket = null;
      socket?.close();
      bridgeAuthenticated = false;
      clientApiKey = "";
      companionNetworkScope = "unknown";
      companionClientIpAllowlist = false;
      updateBadge();
      return { ok: true };
    }
    if (message?.type === "POPUP_CONFIGURE_OPENCODE") {
      return { ok: true, result: await configureOpenCodeManually() };
    }
    if (message?.type === "POPUP_ROTATE_API_KEY") {
      return { ok: true, result: await rotateClientApiKey() };
    }
    if (message?.type === "POPUP_RESET_USAGE") {
      return { ok: true, result: await resetUsageStats() };
    }
    if (message?.type === "POPUP_SET_NETWORK_SCOPE") {
      const scope = message.scope;
      if (scope !== "loopback" && scope !== "lan") {
        throw new Error("Network scope must be loopback or lan.");
      }
      return {
        ok: true,
        result: await setCompanionNetworkScope(scope),
      };
    }
    if (message?.type === "POPUP_APPLY_UPDATE") {
      return { ok: true, result: await applyAvailableUpdate() };
    }
    if (message?.type === "POPUP_OPEN_VAL") {
      const tabs = await chrome.tabs.query({ url: `${VAL_ORIGIN}/*` });
      if (tabs[0]?.id) {
        await chrome.tabs.update(tabs[0].id, { active: true });
      } else {
        await chrome.tabs.create({ url: VAL_ORIGIN });
      }
      return { ok: true };
    }
    return { ok: false };
  };

  void run()
    .then((result) => sendResponse(result))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return true;
});

async function bootstrap() {
  await chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const stored = await chrome.storage.session.get([
    SESSION_TOKEN_KEY,
    USAGE_STATS_KEY,
  ]);
  const storedLocal = await chrome.storage.local.get([
    UPDATE_STATUS_KEY,
    OPENCODE_AUTO_CONFIG_KEY,
    LAST_EXTENSION_VERSION_KEY,
  ]);
  extensionUpdateStatus = restoreUpdateStatus(
    storedLocal[UPDATE_STATUS_KEY],
    EXTENSION_VERSION,
  );
  openCodeAutoConfigState = restoreOpenCodeAutoConfigState(
    storedLocal[OPENCODE_AUTO_CONFIG_KEY],
    EXTENSION_VERSION,
  );
  await chrome.storage.local.set({
    [LAST_EXTENSION_VERSION_KEY]: EXTENSION_VERSION,
  });
  if (
    extensionVersionWasUpdated(
      storedLocal[LAST_EXTENSION_VERSION_KEY],
      EXTENSION_VERSION,
    )
  ) {
    await markOpenCodeAutoConfigPending(EXTENSION_VERSION);
  }
  usageStats = restoreSessionUsageStats(stored[USAGE_STATS_KEY]);
  await ensureUpdateAlarm();
  if (
    typeof stored[SESSION_TOKEN_KEY] === "string" &&
    stored[SESSION_TOKEN_KEY]
  ) {
    valToken = stored[SESSION_TOKEN_KEY];
    updateStatus({ valSession: true });
    connectValSocket(valToken);
    void verifyValCompatibility();
  } else {
    await refreshTokenFromValTab();
  }
  await connectBridge();
  void checkForUpdates();
  requestAutomaticOpenCodeConfig();
  updateBadge();
}

let bootstrapPromise: Promise<void> | undefined;

function startBootstrap() {
  bootstrapPromise ??= bootstrap().finally(() => {
    bootstrapPromise = undefined;
  });
  return bootstrapPromise;
}

function runBootstrap() {
  void startBootstrap().catch((error) => {
    updateStatus({
      lastError:
        error instanceof Error ? error.message : "Extension startup failed.",
    });
  });
}

chrome.runtime.onStartup.addListener(runBootstrap);
chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    if (details.reason === "update") {
      await markOpenCodeAutoConfigPending(EXTENSION_VERSION);
    }
    await startBootstrap();
  })().catch((error) => {
    updateStatus({
      lastError:
        error instanceof Error ? error.message : "Extension startup failed.",
    });
  });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM_NAME) {
    void checkForUpdates(true);
  } else if (alarm.name === OPENCODE_AUTO_CONFIG_ALARM_NAME) {
    requestAutomaticOpenCodeConfig();
  }
});
runBootstrap();
