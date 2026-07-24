type PopupStatus = {
  bridgeConnected: boolean;
  bridgePaired: boolean;
  bridgeUrl: string;
  clientApiKey?: string;
  valSession: boolean;
  valSocket: boolean;
  compatible: boolean;
  lastError?: string;
  stats: {
    requests: number;
    completedRequests: number;
    failedRequests: number;
    cancelledRequests: number;
    meteredRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
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
const pairingPanel = element<HTMLFormElement>("#pairing-panel");
const endpointPanel = element<HTMLElement>("#endpoint-panel");
const apiBase = element<HTMLElement>("#api-base");
const apiKeyElement = element<HTMLElement>("#api-key");
const toggleApiKeyButton = element<HTMLButtonElement>("#toggle-api-key");
const copyApiKeyButton = element<HTMLButtonElement>("#copy-api-key");
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
const requestCount = element<HTMLElement>("#request-count");
const estimatedCost = element<HTMLElement>("#estimated-cost");
const costNote = element<HTMLElement>("#cost-note");
const usageNote = element<HTMLElement>("#usage-note");

let urlEdited = false;
let refreshPending = false;
let currentApiKey = "";
let apiKeyVisible = false;
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
let configurePending = false;

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

  const unfinished = stats.failedRequests + stats.cancelledRequests;
  usageNote.textContent =
    stats.requests === 0
      ? "Resets when the browser closes"
      : stats.meteredRequests < stats.requests
        ? `${numberFormatter.format(stats.meteredRequests)} of ${numberFormatter.format(stats.requests)} requests reported usage`
        : unfinished > 0
          ? `${numberFormatter.format(unfinished)} request${unfinished === 1 ? "" : "s"} did not complete`
          : "Exact usage reported by Val";
  costNote.textContent =
    stats.requests === 0 || stats.pricedRequests === stats.meteredRequests
      ? "OpenAI-equivalent estimate · not a Val charge"
      : stats.pricedRequests === 0
        ? "No priced GPT-5.6 usage reported yet"
        : `${numberFormatter.format(stats.pricedRequests)} of ${numberFormatter.format(stats.meteredRequests)} metered requests matched GPT-5.6 pricing`;
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
  toggleApiKeyButton.textContent = apiKeyVisible ? "Hide" : "Show";
  toggleApiKeyButton.setAttribute("aria-pressed", String(apiKeyVisible));
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
    configureOpenCodeButton.disabled =
      configurePending ||
      !status.bridgeConnected ||
      !status.valSession ||
      !status.valSocket ||
      !status.compatible ||
      !status.clientApiKey;
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
      throw new Error("Enter the six-digit code printed by the companion.");
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
