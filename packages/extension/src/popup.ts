import { COMPANION_LAUNCH_URL } from "@val-bridge/protocol";
import { GPT_56_PRICING_SNAPSHOT_DATE } from "./usage-stats.js";

type PopupStatus = {
  bridgeConnected: boolean;
  bridgePaired: boolean;
  bridgeUrl: string;
  networkScope: "unknown" | "loopback" | "lan";
  clientIpAllowlist: boolean;
  clientApiKey?: string;
  valSession: boolean;
  valSocket: boolean;
  compatible: boolean;
  lastError?: string;
  update: {
    state: "unknown" | "current" | "available" | "error" | "installing";
    currentVersion: string;
    latestVersion?: string;
    checkedAt?: number;
    releaseUrl?: string;
    message?: string;
  };
  openCodeAutoConfig: {
    pending: boolean;
    attempts: number;
    lastError?: string;
  };
  stats: {
    requests: number;
    completedRequests: number;
    failedRequests: number;
    cancelledRequests: number;
    meteredRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens: number;
    reasoningMeteredRequests: number;
    reasoningSummaryRequests: number;
    hiddenReasoningRequests: number;
    lastReasoningTokens?: number;
    lastReasoningTokensReported?: boolean;
    lastReasoningStatus?: "summary" | "hidden" | "unavailable";
    pricedRequests: number;
    estimatedOpenAICostNanodollars: number;
    activeRequests: number;
  };
};

function element<T extends HTMLElement>(selector: string) {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Popup element not found: ${selector}`);
  return match;
}

const companionDot = element<HTMLSpanElement>("#companion-dot");
const companionStatus = element<HTMLSpanElement>("#companion-status");
const sessionDot = element<HTMLSpanElement>("#session-dot");
const sessionStatus = element<HTMLSpanElement>("#session-status");
const socketDot = element<HTMLSpanElement>("#socket-dot");
const socketStatus = element<HTMLSpanElement>("#socket-status");
const launchCompanionButton = element<HTMLButtonElement>("#launch-companion");
const launchCompanionStatus = element<HTMLElement>("#launch-companion-status");
const updatePanel = element<HTMLElement>("#update-panel");
const updateVersion = element<HTMLElement>("#update-version");
const applyUpdateButton = element<HTMLButtonElement>("#apply-update");
const updateStatus = element<HTMLElement>("#update-status");
const pairingPanel = element<HTMLFormElement>("#pairing-panel");
const endpointPanel = element<HTMLElement>("#endpoint-panel");
const apiBase = element<HTMLElement>("#api-base");
const apiKeyElement = element<HTMLElement>("#api-key");
const toggleApiKeyButton = element<HTMLButtonElement>("#toggle-api-key");
const copyApiKeyButton = element<HTMLButtonElement>("#copy-api-key");
const rotateApiKeyButton = element<HTMLButtonElement>("#rotate-api-key");
const networkScopeElement = element<HTMLElement>("#network-scope");
const toggleNetworkScopeButton = element<HTMLButtonElement>(
  "#toggle-network-scope",
);
const networkStatus = element<HTMLElement>("#network-status");
const configureOpenCodeButton = element<HTMLButtonElement>(
  "#configure-opencode",
);
const openCodeStatus = element<HTMLElement>("#opencode-status");
const urlInput = element<HTMLInputElement>("#bridge-url");
const codeInput = element<HTMLInputElement>("#pairing-code");
const pairButton = element<HTMLButtonElement>("#pair-button");
const openValButton = element<HTMLButtonElement>("#open-val");
const unpairButton = element<HTMLButtonElement>("#unpair");
const errorElement = element<HTMLElement>("#error");
const versionElement = element<HTMLElement>("#version");
const usageActivity = element<HTMLElement>("#usage-activity");
const totalTokens = element<HTMLElement>("#total-tokens");
const inputTokens = element<HTMLElement>("#input-tokens");
const outputTokens = element<HTMLElement>("#output-tokens");
const reasoningTokens = element<HTMLElement>("#reasoning-tokens");
const reasoningStatus = element<HTMLElement>("#reasoning-status");
const reasoningNote = element<HTMLElement>("#reasoning-note");
const requestCount = element<HTMLElement>("#request-count");
const estimatedCost = element<HTMLElement>("#estimated-cost");
const costNote = element<HTMLElement>("#cost-note");
const usageNote = element<HTMLElement>("#usage-note");
const resetUsageButton = element<HTMLButtonElement>("#reset-usage");

let urlEdited = false;
let refreshPending = false;
let currentApiKey = "";
let apiKeyVisible = false;
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
let configurePending = false;
let launchPending = false;
let launchResetTimer: ReturnType<typeof setTimeout> | undefined;
let updatePending = false;
let rotatePending = false;
let resetUsagePending = false;
let networkPending = false;
let currentNetworkScope: PopupStatus["networkScope"] = "unknown";
let renderedAutoConfigPending = false;

function dot(element: HTMLElement, state: boolean | null) {
  element.classList.toggle("good", state === true);
  element.classList.toggle("bad", state === false);
}

function showError(message = "") {
  errorElement.textContent = message;
  errorElement.hidden = !message;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const numberFormatter = new Intl.NumberFormat("en-AU");
const costFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "code",
  minimumFractionDigits: 4,
  maximumFractionDigits: 8,
});
const pricingSnapshotDate = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(`${GPT_56_PRICING_SNAPSHOT_DATE}T00:00:00Z`));

function tokenText(value: number, available: boolean) {
  return available ? numberFormatter.format(value) : "—";
}

function costText(value: number, available: boolean) {
  return available ? costFormatter.format(value / 1_000_000_000) : "—";
}

function renderUsage(stats: PopupStatus["stats"]) {
  const usageAvailable = stats.requests === 0 || stats.meteredRequests > 0;
  const costAvailable = stats.requests === 0 || stats.pricedRequests > 0;
  totalTokens.textContent = tokenText(stats.totalTokens, usageAvailable);
  inputTokens.textContent = tokenText(stats.inputTokens, usageAvailable);
  outputTokens.textContent = tokenText(stats.outputTokens, usageAvailable);
  reasoningTokens.textContent = tokenText(
    stats.reasoningTokens,
    stats.requests === 0 || stats.reasoningMeteredRequests > 0,
  );
  requestCount.textContent = numberFormatter.format(stats.requests);
  estimatedCost.textContent = costText(
    stats.estimatedOpenAICostNanodollars,
    costAvailable,
  );

  usageActivity.textContent =
    stats.activeRequests > 0
      ? `${numberFormatter.format(stats.activeRequests)} active`
      : "Idle";
  usageActivity.classList.toggle("busy", stats.activeRequests > 0);

  const reasoningAvailability =
    stats.lastReasoningStatus === "summary"
      ? "Summary received"
      : stats.lastReasoningStatus === "hidden"
        ? "Used, summary hidden"
        : stats.lastReasoningStatus === "unavailable"
          ? stats.lastReasoningTokensReported
            ? "None used"
            : "Not returned"
          : "Not reported yet";
  const lastReasoningCount = stats.lastReasoningTokensReported
    ? `${numberFormatter.format(stats.lastReasoningTokens ?? 0)} ${
        stats.lastReasoningTokens === 1 ? "token" : "tokens"
      }`
    : "";
  reasoningStatus.textContent = lastReasoningCount
    ? `${reasoningAvailability} · ${lastReasoningCount}`
    : reasoningAvailability;
  const disclosed = stats.reasoningSummaryRequests;
  const hidden = stats.hiddenReasoningRequests;
  reasoningNote.textContent =
    stats.requests === 0
      ? "Genuine summaries appear only when Val returns their text."
      : disclosed > 0 || hidden > 0
        ? `${numberFormatter.format(disclosed)} ${disclosed === 1 ? "summary" : "summaries"} received · ${numberFormatter.format(hidden)} hidden`
        : "No reasoning summary text has been returned this session.";

  const unfinished = stats.failedRequests + stats.cancelledRequests;
  const usageDetail =
    stats.requests === 0
      ? "No usage recorded yet"
      : stats.meteredRequests < stats.requests
        ? `${numberFormatter.format(stats.meteredRequests)} of ${numberFormatter.format(stats.requests)} requests reported usage`
        : unfinished > 0
          ? `${numberFormatter.format(unfinished)} request${unfinished === 1 ? "" : "s"} did not complete`
          : "Exact usage reported by Val";
  usageNote.textContent = `${usageDetail} · saved to companion disk`;
  costNote.textContent =
    stats.requests === 0 || stats.pricedRequests === stats.meteredRequests
      ? `OpenAI-equivalent estimate · rates ${pricingSnapshotDate} · not a Val charge`
      : stats.pricedRequests === 0
        ? "No priced GPT-5.6 usage reported yet"
        : `${numberFormatter.format(stats.pricedRequests)} of ${numberFormatter.format(stats.meteredRequests)} metered requests matched the ${pricingSnapshotDate} GPT-5.6 rates`;
}

function renderApiKey(apiKey?: string) {
  const nextApiKey = apiKey ?? "";
  if (nextApiKey !== currentApiKey) {
    currentApiKey = nextApiKey;
    apiKeyVisible = false;
  }

  const available = currentApiKey.length > 0;
  apiKeyElement.textContent = !available
    ? "Companion unavailable"
    : apiKeyVisible
      ? currentApiKey
      : `${"•".repeat(16)}${currentApiKey.slice(-4)}`;
  apiKeyElement.setAttribute(
    "aria-label",
    !available
      ? "Client API key unavailable"
      : apiKeyVisible
        ? "Client API key visible"
        : "Client API key hidden",
  );
  toggleApiKeyButton.disabled = !available;
  copyApiKeyButton.disabled = !available;
  rotateApiKeyButton.disabled = !available || rotatePending;
  toggleApiKeyButton.textContent = apiKeyVisible ? "Hide" : "Show";
  toggleApiKeyButton.setAttribute("aria-pressed", String(apiKeyVisible));
}

function renderNetwork(status: PopupStatus) {
  const scope = status.networkScope;
  currentNetworkScope = scope;
  networkScopeElement.textContent =
    scope === "lan"
      ? "Trusted LAN"
      : scope === "loopback"
        ? "This device only"
        : "Unavailable";
  networkScopeElement.classList.toggle("lan", scope === "lan");
  toggleNetworkScopeButton.disabled =
    networkPending || !status.bridgeConnected || scope === "unknown";
  toggleNetworkScopeButton.textContent = networkPending
    ? "Restarting companion..."
    : scope === "lan"
      ? "Use this device only"
      : "Enable trusted LAN";
  if (networkPending) {
    networkStatus.textContent =
      "Applying the setting and restarting the companion...";
  } else if (scope === "lan") {
    networkStatus.textContent = status.clientIpAllowlist
      ? "LAN clients require the API key and an allowed IP address."
      : "LAN clients require the API key; HTTP traffic is unencrypted.";
  } else if (scope === "loopback") {
    networkStatus.textContent = "Only applications on this device can connect.";
  } else {
    networkStatus.textContent =
      "Connect the companion to inspect network access.";
  }
}

function renderUpdate(update: PopupStatus["update"], bridgeConnected: boolean) {
  const visible = update.state === "available" || update.state === "installing";
  updatePanel.hidden = !visible;
  if (!visible) return;

  const latest = update.latestVersion
    ? `v${update.latestVersion}`
    : "new version";
  updateVersion.textContent = `v${update.currentVersion} → ${latest}`;
  if (update.state === "installing" || updatePending) {
    applyUpdateButton.textContent = "Updating…";
    applyUpdateButton.disabled = true;
    updateStatus.textContent =
      "The companion is restarting; the extension will reload automatically.";
    return;
  }

  applyUpdateButton.textContent = "Update everything";
  applyUpdateButton.disabled = !bridgeConnected;
  updateStatus.textContent = update.message
    ? `${update.message} Reconnect the companion and try again.`
    : bridgeConnected
      ? "Updates the companion and extension, then reloads both cleanly."
      : "Launch the companion before applying this update.";
}

function renderOpenCodeAutoConfig(status: PopupStatus) {
  if (configurePending) return;
  const migration = status.openCodeAutoConfig;
  if (migration.pending) {
    renderedAutoConfigPending = true;
    configureOpenCodeButton.textContent = "Configure now";
    const ready =
      status.bridgeConnected &&
      status.valSession &&
      status.valSocket &&
      status.compatible;
    openCodeStatus.textContent =
      migration.attempts > 0
        ? `Automatic refresh will retry: ${
            migration.lastError ?? "temporary configuration failure"
          }`
        : ready
          ? "Refreshing OpenCode automatically for this update…"
          : "Waiting for the companion and Val before refreshing automatically.";
    return;
  }
  if (renderedAutoConfigPending) {
    renderedAutoConfigPending = false;
    configureOpenCodeButton.textContent = "Configure OpenCode";
    openCodeStatus.textContent =
      "Refreshes automatically after updates; rerun anytime.";
  }
}

async function message<T>(payload: Record<string, unknown>): Promise<T> {
  const result: unknown = await chrome.runtime.sendMessage(payload);
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (record.ok === false) {
      throw new Error(
        typeof record.error === "string"
          ? record.error
          : "Extension request failed.",
      );
    }
  }
  return result as T;
}

async function refresh() {
  if (refreshPending) return;
  refreshPending = true;
  try {
    const status = await message<PopupStatus>({ type: "POPUP_GET_STATUS" });
    dot(
      companionDot,
      status.bridgeConnected ? true : status.bridgePaired ? false : null,
    );
    companionStatus.textContent = status.bridgeConnected
      ? "Connected"
      : status.bridgePaired
        ? "Offline"
        : "Not paired";
    if (status.bridgeConnected) {
      launchPending = false;
      if (launchResetTimer) {
        clearTimeout(launchResetTimer);
        launchResetTimer = undefined;
      }
      launchCompanionButton.textContent = "Companion running";
      launchCompanionStatus.textContent = "Connected";
    } else if (!launchPending) {
      launchCompanionButton.textContent = "Launch companion";
      launchCompanionStatus.textContent = "Checks for updates before starting";
    }
    launchCompanionButton.disabled = status.bridgeConnected || launchPending;
    launchCompanionButton.classList.toggle("running", status.bridgeConnected);

    dot(sessionDot, status.valSession);
    sessionStatus.textContent = status.valSession ? "Signed in" : "Open Val";

    const relayReady = status.valSocket && status.compatible;
    dot(socketDot, relayReady ? true : status.valSession ? false : null);
    socketStatus.textContent = !status.compatible
      ? "Incompatible"
      : status.valSocket
        ? "Ready"
        : "Waiting";

    if (!urlEdited) urlInput.value = status.bridgeUrl;
    pairingPanel.hidden = status.bridgePaired;
    endpointPanel.hidden = !status.bridgePaired;
    unpairButton.hidden = !status.bridgePaired;
    apiBase.textContent = `${status.bridgeUrl}/v1`;
    renderApiKey(status.clientApiKey);
    renderNetwork(status);
    resetUsageButton.disabled =
      resetUsagePending ||
      !status.bridgeConnected ||
      status.stats.activeRequests > 0;
    configureOpenCodeButton.disabled =
      configurePending ||
      !status.bridgeConnected ||
      !status.valSession ||
      !status.valSocket ||
      !status.compatible ||
      !status.clientApiKey;
    renderOpenCodeAutoConfig(status);
    renderUpdate(status.update, status.bridgeConnected);
    renderUsage(status.stats);
    showError(status.lastError ?? "");
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    refreshPending = false;
  }
}

urlInput.addEventListener("input", () => {
  urlEdited = true;
});

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
});

launchCompanionButton.addEventListener("click", async () => {
  launchPending = true;
  launchCompanionButton.disabled = true;
  launchCompanionButton.textContent = "Launching…";
  launchCompanionStatus.textContent = "Opening the installed launcher…";
  showError();
  try {
    await chrome.tabs.create({
      url: COMPANION_LAUNCH_URL,
      active: true,
    });
    await message({ type: "POPUP_RECONNECT_BRIDGE" });
    launchCompanionStatus.textContent =
      "Update check requested; waiting for companion…";
    if (launchResetTimer) clearTimeout(launchResetTimer);
    launchResetTimer = setTimeout(() => {
      launchPending = false;
      launchResetTimer = undefined;
      void refresh();
    }, 15_000);
  } catch (error) {
    launchPending = false;
    launchCompanionButton.textContent = "Launch companion";
    launchCompanionStatus.textContent =
      "Launcher unavailable; rerun the latest installer";
    showError(`Could not open the companion launcher: ${errorMessage(error)}`);
    await refresh();
  }
});

applyUpdateButton.addEventListener("click", async () => {
  updatePending = true;
  applyUpdateButton.disabled = true;
  applyUpdateButton.textContent = "Updating…";
  updateStatus.textContent = "Preparing a clean restart…";
  showError();
  try {
    const response = await message<{
      ok: true;
      result: { latestVersion: string };
    }>({ type: "POPUP_APPLY_UPDATE" });
    updateStatus.textContent = `Installing v${response.result.latestVersion}; the extension will reload automatically.`;
  } catch (error) {
    updatePending = false;
    showError(errorMessage(error));
    await refresh();
  }
});

toggleApiKeyButton.addEventListener("click", () => {
  if (!currentApiKey) return;
  apiKeyVisible = !apiKeyVisible;
  renderApiKey(currentApiKey);
});

copyApiKeyButton.addEventListener("click", async () => {
  if (!currentApiKey) return;
  showError();
  try {
    await navigator.clipboard.writeText(currentApiKey);
    copyApiKeyButton.textContent = "Copied";
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyApiKeyButton.textContent = "Copy";
      copyResetTimer = undefined;
    }, 1_500);
  } catch (error) {
    showError(`Could not copy the API key: ${errorMessage(error)}`);
  }
});

rotateApiKeyButton.addEventListener("click", async () => {
  if (
    !window.confirm(
      "Rotate the client API key? Existing OpenCode and LAN clients will stop working until reconfigured.",
    )
  ) {
    return;
  }
  rotatePending = true;
  rotateApiKeyButton.disabled = true;
  rotateApiKeyButton.textContent = "Rotating...";
  showError();
  try {
    await message({ type: "POPUP_ROTATE_API_KEY" });
    apiKeyVisible = false;
    openCodeStatus.textContent =
      "API key rotated. Reconfigure OpenCode and other clients.";
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    rotatePending = false;
    rotateApiKeyButton.textContent = "Rotate";
    await refresh();
  }
});

resetUsageButton.addEventListener("click", async () => {
  if (!window.confirm("Reset all saved request, token, and cost totals?")) {
    return;
  }
  resetUsagePending = true;
  resetUsageButton.disabled = true;
  resetUsageButton.textContent = "Resetting...";
  showError();
  try {
    await message({ type: "POPUP_RESET_USAGE" });
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    resetUsagePending = false;
    resetUsageButton.textContent = "Reset usage totals";
    await refresh();
  }
});

toggleNetworkScopeButton.addEventListener("click", async () => {
  const enableLan = currentNetworkScope !== "lan";
  if (
    enableLan &&
    !window.confirm(
      "Enable trusted LAN access? Prompts and responses can cross your local network over unencrypted HTTP and still require the API key.",
    )
  ) {
    return;
  }
  networkPending = true;
  toggleNetworkScopeButton.disabled = true;
  showError();
  try {
    const response = await message<{
      ok: true;
      result: {
        scope: "loopback" | "lan";
        restarting: boolean;
        restartRequired?: boolean;
      };
    }>({
      type: "POPUP_SET_NETWORK_SCOPE",
      scope: enableLan ? "lan" : "loopback",
    });
    if (response.result.restartRequired && !response.result.restarting) {
      networkStatus.textContent =
        "Setting saved. Restart the companion to apply it.";
    }
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    networkPending = false;
    await refresh();
  }
});

configureOpenCodeButton.addEventListener("click", async () => {
  configurePending = true;
  configureOpenCodeButton.disabled = true;
  configureOpenCodeButton.textContent = "Configuring…";
  openCodeStatus.textContent = "Reading current Val models…";
  showError();
  try {
    const response = await message<{
      ok: true;
      result: {
        modelsConfigured: number;
        updated: boolean;
        backupCreated: boolean;
      };
    }>({ type: "POPUP_CONFIGURE_OPENCODE" });
    const count = response.result.modelsConfigured;
    renderedAutoConfigPending = false;
    configureOpenCodeButton.textContent = "Configured";
    openCodeStatus.textContent = response.result.updated
      ? `Configured ${numberFormatter.format(count)} model${count === 1 ? "" : "s"}. Restart OpenCode to apply it.`
      : `OpenCode already has the current ${numberFormatter.format(count)} model${count === 1 ? "" : "s"}.`;
  } catch (error) {
    configureOpenCodeButton.textContent = "Configure OpenCode";
    openCodeStatus.textContent = "OpenCode was not changed.";
    showError(errorMessage(error));
  } finally {
    configurePending = false;
    await refresh();
  }
});

pairingPanel.addEventListener("submit", async (event) => {
  event.preventDefault();
  pairButton.disabled = true;
  showError();
  try {
    if (!/^\d{6}$/.test(codeInput.value.trim())) {
      throw new Error("Enter the six-digit code shown by the companion.");
    }
    await message({
      type: "POPUP_PAIR",
      code: codeInput.value.trim(),
      url: urlInput.value.trim(),
    });
    codeInput.value = "";
    urlEdited = false;
    await refresh();
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    pairButton.disabled = false;
  }
});

openValButton.addEventListener("click", async () => {
  openValButton.disabled = true;
  showError();
  try {
    await message({ type: "POPUP_OPEN_VAL" });
    window.close();
  } catch (error) {
    showError(errorMessage(error));
    openValButton.disabled = false;
  }
});

unpairButton.addEventListener("click", async () => {
  unpairButton.disabled = true;
  showError();
  try {
    await message({ type: "POPUP_UNPAIR" });
    await refresh();
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    unpairButton.disabled = false;
  }
});

versionElement.textContent = `v${chrome.runtime.getManifest().version}`;
void refresh();
setInterval(() => void refresh(), 1_500);
