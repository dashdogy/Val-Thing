export const PROTOCOL_VERSION = 2;
export const COMPANION_LAUNCH_URL = "val-openai-bridge://launch";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | {
      type: "image_url";
      image_url: string | { url: string; detail?: string };
    }
  | {
      type: "input_image";
      image_url?: string;
      file_id?: string;
      detail?: string;
    };

export type OpenAIMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
};

export type OpenAIFunction = {
  name: string;
  description?: string;
  parameters?: JsonObject;
  strict?: boolean;
};

export type OpenAITool = {
  type: "function";
  function: OpenAIFunction;
};

export type OpenAIToolCall = {
  id: string;
  type: "function";
  index?: number;
  function: {
    name: string;
    arguments: string;
  };
};

export type RelayPersistence =
  | { mode: "temporary" }
  | {
      mode: "stored";
      chatId?: string;
      appendToExisting?: boolean;
      title?: string;
    };

export type RelayCompletionRequest = {
  kind: "completion";
  model: string;
  messages: OpenAIMessage[];
  parameters?: JsonObject;
  tools?: OpenAITool[];
  toolChoice?: JsonValue;
  responseFormat?: JsonValue;
  persistence: RelayPersistence;
};

export type RelayModelsRequest = {
  kind: "models";
};

export type RelayRequest = RelayModelsRequest | RelayCompletionRequest;

export type ValModel = {
  id: string;
  name?: string;
  created?: number;
  owned_by?: string;
  info?: JsonObject;
  [key: string]: unknown;
};

export type ValRelayEvent =
  | { kind: "openai"; data: JsonObject }
  | { kind: "delta"; content: string }
  | { kind: "replace"; content: string }
  | { kind: "usage"; usage: JsonObject }
  | { kind: "status"; data: JsonObject }
  | { kind: "error"; error: RelayError };

export type RelayAccepted = {
  taskId?: string;
  chatId?: string;
  messageId?: string;
};

export type RelayDoneResult = {
  chatId?: string;
  content?: string;
  toolCalls?: OpenAIToolCall[];
  usage?: JsonObject;
  models?: ValModel[];
};

export type RelayError = {
  code: string;
  message: string;
  status?: number;
  details?: JsonValue;
};

export type ExtensionStatus = {
  extensionConnected: boolean;
  valSession: boolean;
  valSocket: boolean;
  compatible: boolean;
  lastError?: string;
};

export type ServerToExtensionMessage =
  | {
      type: "bridge.authenticated";
      protocolVersion: number;
      clientApiKey: string;
    }
  | {
      type: "relay.request";
      id: string;
      request: RelayRequest;
    }
  | {
      type: "relay.cancel";
      id: string;
    }
  | {
      type: "bridge.ping";
      timestamp: number;
    }
  | {
      type: "bridge.reload";
    };

export type ExtensionToServerMessage =
  | {
      type: "bridge.auth";
      protocolVersion: number;
      extensionId: string;
      secret: string;
    }
  | {
      type: "bridge.status";
      status: ExtensionStatus;
    }
  | {
      type: "bridge.pong";
      timestamp: number;
    }
  | {
      type: "relay.accepted";
      id: string;
      accepted: RelayAccepted;
    }
  | {
      type: "relay.event";
      id: string;
      event: ValRelayEvent;
    }
  | {
      type: "relay.done";
      id: string;
      result: RelayDoneResult;
    }
  | {
      type: "relay.error";
      id: string;
      error: RelayError;
    };

export type PairRequest = {
  code: string;
  extensionId: string;
  protocolVersion: number;
};

export type PairResponse = {
  bridgeSecret: string;
  protocolVersion: number;
};
