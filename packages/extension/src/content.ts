const TOKEN_MESSAGE = "VAL_SESSION_UPDATE";
const GET_TOKEN_MESSAGE = "VAL_GET_SESSION_TOKEN";

function currentToken() {
  try {
    return window.localStorage.getItem("token") ?? "";
  } catch {
    return "";
  }
}

function synchronizeToken() {
  const token = currentToken();
  void chrome.runtime
    .sendMessage({
      type: TOKEN_MESSAGE,
      token,
    })
    .catch(() => {
      // The background worker may be restarting; the periodic sync will retry.
    });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === GET_TOKEN_MESSAGE) {
    sendResponse({ token: currentToken() });
  }
});

window.addEventListener("storage", (event) => {
  if (event.key === "token") synchronizeToken();
});

synchronizeToken();
setInterval(synchronizeToken, 5_000);
