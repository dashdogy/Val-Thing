import { randomUUID } from "node:crypto";
import type {
  ExtensionStatus,
  ExtensionToServerMessage,
  RelayAccepted,
  RelayDoneResult,
  RelayError,
  RelayRequest,
  ServerToExtensionMessage,
  ValRelayEvent,
} from "@val-bridge/protocol";
import { PROTOCOL_VERSION } from "@val-bridge/protocol";
import type WebSocket from "ws";
import { OpenAIHttpError, relayErrorToHttp } from "./errors.js";
import type { SecretsStore } from "./config.js";

type ExecuteCallbacks = {
  onAccepted?: (accepted: RelayAccepted) => void;
  onEvent?: (event: ValRelayEvent) => void;
};

type PendingRequest = {
  resolve: (result: RelayDoneResult) => void;
  reject: (error: unknown) => void;
  callbacks: ExecuteCallbacks;
  timeout: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
};

type ActiveExtension = {
  socket: WebSocket;
  authenticated: boolean;
  originExtensionId: string;
  extensionId?: string;
};

const disconnectedStatus: ExtensionStatus = {
  extensionConnected: false,
  valSession: false,
  valSocket: false,
  compatible: false,
};

function parseMessage(
  data: WebSocket.RawData,
): ExtensionToServerMessage | null {
  try {
    return JSON.parse(data.toString()) as ExtensionToServerMessage;
  } catch {
    return null;
  }
}

export class BridgeHub {
  private active?: ActiveExtension;
  private status: ExtensionStatus = { ...disconnectedStatus };
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly secrets: SecretsStore,
    private readonly requestTimeoutMs: number,
  ) {}

  getStatus() {
    return { ...this.status };
  }

  hasReadyExtension() {
    return Boolean(
      this.active?.authenticated &&
      this.active.socket.readyState === this.active.socket.OPEN &&
      this.status.valSession &&
      this.status.valSocket &&
      this.status.compatible,
    );
  }

  attach(socket: WebSocket, originExtensionId: string) {
    const connection: ActiveExtension = {
      socket,
      authenticated: false,
      originExtensionId,
    };

    const authenticationTimeout = setTimeout(() => {
      if (!connection.authenticated) {
        socket.close(4401, "Authentication required");
      }
    }, 5_000);
    authenticationTimeout.unref();

    socket.on("message", (data) => {
      const message = parseMessage(data);
      if (!message) {
        socket.close(4400, "Invalid bridge message");
        return;
      }

      if (!connection.authenticated) {
        if (message.type !== "bridge.auth") {
          socket.close(4401, "Authentication required");
          return;
        }
        const configured = this.secrets.get();
        if (
          message.protocolVersion !== PROTOCOL_VERSION ||
          message.secret !== configured.bridgeSecret ||
          !configured.extensionId ||
          message.extensionId !== configured.extensionId ||
          message.extensionId !== connection.originExtensionId
        ) {
          socket.close(4403, "Bridge authentication failed");
          return;
        }

        clearTimeout(authenticationTimeout);
        connection.authenticated = true;
        connection.extensionId = message.extensionId;

        if (this.active && this.active.socket !== socket) {
          this.active.socket.close(
            4001,
            "Replaced by a newer extension connection",
          );
        }
        this.active = connection;
        this.status = {
          extensionConnected: true,
          valSession: false,
          valSocket: false,
          compatible: true,
        };
        this.send(socket, {
          type: "bridge.authenticated",
          protocolVersion: PROTOCOL_VERSION,
          clientApiKey: configured.clientApiKey,
        });
        return;
      }

      this.handleAuthenticatedMessage(message);
    });

    socket.on("close", () => {
      clearTimeout(authenticationTimeout);
      if (this.active?.socket === socket) {
        this.active = undefined;
        this.status = { ...disconnectedStatus };
        this.rejectAll(
          new OpenAIHttpError(
            503,
            "extension_disconnected",
            "The Helium extension disconnected while the request was running.",
            "api_connection_error",
          ),
        );
      }
    });

    socket.on("error", () => {
      // The close handler owns status and pending-request cleanup.
    });
  }

  private handleAuthenticatedMessage(message: ExtensionToServerMessage) {
    switch (message.type) {
      case "bridge.status":
        this.status = {
          ...message.status,
          extensionConnected: true,
        };
        break;
      case "bridge.pong":
      case "bridge.auth":
        break;
      case "relay.accepted":
        this.pending.get(message.id)?.callbacks.onAccepted?.(message.accepted);
        break;
      case "relay.event":
        this.pending.get(message.id)?.callbacks.onEvent?.(message.event);
        break;
      case "relay.done": {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.cleanupPending(message.id, pending);
          pending.resolve(message.result);
        }
        break;
      }
      case "relay.error": {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.cleanupPending(message.id, pending);
          pending.reject(relayErrorToHttp(message.error));
        }
        break;
      }
      default:
        break;
    }
  }

  async execute(
    request: RelayRequest,
    callbacks: ExecuteCallbacks = {},
    signal?: AbortSignal,
  ): Promise<RelayDoneResult> {
    if (
      !this.active?.authenticated ||
      this.active.socket.readyState !== this.active.socket.OPEN
    ) {
      throw new OpenAIHttpError(
        503,
        "extension_unavailable",
        "The Val bridge extension is not connected.",
        "api_connection_error",
      );
    }
    if (!this.status.valSession) {
      throw new OpenAIHttpError(
        503,
        "val_session_unavailable",
        "Open and sign in to Val in Helium, then retry the request.",
        "api_connection_error",
      );
    }
    if (!this.status.valSocket) {
      throw new OpenAIHttpError(
        503,
        "val_socket_unavailable",
        "The extension has not connected to Val's chat service.",
        "api_connection_error",
      );
    }
    if (!this.status.compatible) {
      throw new OpenAIHttpError(
        503,
        "val_incompatible",
        this.status.lastError ??
          "The current Val deployment is incompatible with this bridge.",
        "api_connection_error",
      );
    }
    if (signal?.aborted) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }

    const id = randomUUID();
    return await new Promise<RelayDoneResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.sendActive({ type: "relay.cancel", id });
        this.cleanupPending(id, pending);
        reject(
          new OpenAIHttpError(
            504,
            "upstream_timeout",
            "Val did not complete the request before the configured timeout.",
            "api_connection_error",
          ),
        );
      }, this.requestTimeoutMs);
      timeout.unref();

      const pending: PendingRequest = {
        resolve,
        reject,
        callbacks,
        timeout,
        ...(signal ? { signal } : {}),
      };

      if (signal) {
        const abortListener = () => {
          const current = this.pending.get(id);
          if (!current) return;
          this.sendActive({ type: "relay.cancel", id });
          this.cleanupPending(id, current);
          reject(new DOMException("The request was cancelled.", "AbortError"));
        };
        pending.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }

      this.pending.set(id, pending);
      this.sendActive({ type: "relay.request", id, request });
    });
  }

  ping() {
    if (
      this.active?.authenticated &&
      this.active.socket.readyState === this.active.socket.OPEN
    ) {
      this.sendActive({ type: "bridge.ping", timestamp: Date.now() });
    }
  }

  reloadExtension() {
    if (
      !this.active?.authenticated ||
      this.active.socket.readyState !== this.active.socket.OPEN
    ) {
      return false;
    }
    this.sendActive({ type: "bridge.reload" });
    return true;
  }

  close(error?: RelayError) {
    if (this.active) {
      this.active.socket.close(1001, "Companion shutting down");
      this.active = undefined;
    }
    this.status = { ...disconnectedStatus };
    this.rejectAll(
      error
        ? relayErrorToHttp(error)
        : new OpenAIHttpError(
            503,
            "bridge_shutdown",
            "The local bridge is shutting down.",
            "api_connection_error",
          ),
    );
  }

  private cleanupPending(id: string, pending: PendingRequest) {
    clearTimeout(pending.timeout);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    this.pending.delete(id);
  }

  private rejectAll(error: unknown) {
    for (const [id, pending] of this.pending) {
      this.cleanupPending(id, pending);
      pending.reject(error);
    }
  }

  private sendActive(message: ServerToExtensionMessage) {
    if (!this.active) {
      return;
    }
    this.send(this.active.socket, message);
  }

  private send(socket: WebSocket, message: ServerToExtensionMessage) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
