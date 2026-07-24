import { randomUUID } from "./uuid.js";
import type {
  JsonObject,
  OpenAIMessage,
  OpenAIToolCall,
  RelayCompletionRequest,
} from "@val-bridge/protocol";

export type ValHistoryMessage = {
  id: string;
  parentId: string | null;
  childrenIds: string[];
  role: OpenAIMessage["role"];
  content: string;
  timestamp: number;
  model?: string;
  done?: boolean;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  usage?: JsonObject;
};

export type BuiltHistory = {
  history: {
    currentId: string;
    messages: Record<string, ValHistoryMessage>;
  };
  messages: ValHistoryMessage[];
  assistantMessageId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function reasoningTextParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => reasoningTextParts(part)).join("");
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return reasoningTextParts(value.content);
  if (Array.isArray(value.summary)) return reasoningTextParts(value.summary);
  return "";
}

export function assistantTextFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
      if (
        type.includes("reasoning") ||
        type.includes("thinking") ||
        type === "summary_text"
      ) {
        return "";
      }
      if (
        type &&
        !["text", "input_text", "output_text", "content"].includes(type)
      ) {
        return "";
      }
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return assistantTextFromContent(part.content);
    })
    .join("");
}

function firstReasoningText(values: unknown[]) {
  for (const value of values) {
    const text = reasoningTextParts(value);
    if (text) return text;
  }
  return "";
}

const reasoningCloseTags = [
  "</details>",
  "</think>",
  "</thinking>",
  "</reasoning>",
];

export function normalizeValReasoningText(text: string) {
  let normalized = text;
  const lastOpening = normalized.lastIndexOf("<");
  if (lastOpening >= 0) {
    const compactSuffix = normalized
      .slice(lastOpening)
      .replace(/\s+/g, "")
      .toLowerCase();
    if (
      compactSuffix &&
      reasoningCloseTags.some((tag) => tag.startsWith(compactSuffix))
    ) {
      normalized = normalized.slice(0, lastOpening);
    }
  }

  normalized = normalized
    .replace(/<\/?(?:think|thinking|reasoning)\b[^>]*>/gi, "")
    .replace(
      /<details\b(?=[^>]*\btype\s*=\s*(?:"reasoning"|'reasoning'|reasoning)(?:\s|>|\/))[^>]*>/gi,
      "",
    )
    .replace(/<\/details>/gi, "");

  const nonemptyLines = normalized.split(/\r?\n/).filter((line) => line.trim());
  if (
    nonemptyLines.length > 0 &&
    nonemptyLines.every((line) => /^\s*>/.test(line))
  ) {
    normalized = normalized.replace(/^\s*>\s?/gm, "").trim();
  }

  return normalized;
}

export function reasoningTextFromRecord(
  record: Record<string, unknown> | undefined,
): string {
  if (!record) return "";
  const direct = firstReasoningText([
    record.reasoning_content,
    record.reasoning_text,
    record.reasoning_details,
    record.reasoning_summary,
    record.thinking,
    record.reasoning,
  ]);
  if (direct) return normalizeValReasoningText(direct);

  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type.includes("reasoning") || type.includes("thinking")) {
    const eventText = firstReasoningText([
      record.delta,
      record.text,
      record.content,
      record.summary,
    ]);
    if (eventText) return normalizeValReasoningText(eventText);
  }
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (!isRecord(part)) continue;
      const partType =
        typeof part.type === "string" ? part.type.toLowerCase() : "";
      if (
        !partType.includes("reasoning") &&
        !partType.includes("thinking") &&
        partType !== "summary_text"
      ) {
        continue;
      }
      const partText =
        reasoningTextFromRecord(part) ||
        firstReasoningText([part.text, part.content, part.summary, part.delta]);
      if (partText) return normalizeValReasoningText(partText);
    }
  }
  if (isRecord(record.item)) {
    const itemText: string = reasoningTextFromRecord(record.item);
    if (itemText) return itemText;
  }
  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!isRecord(item)) continue;
      const itemType =
        typeof item.type === "string" ? item.type.toLowerCase() : "";
      if (!itemType.includes("reasoning") && !itemType.includes("thinking")) {
        continue;
      }
      const itemText: string =
        reasoningTextFromRecord(item) ||
        firstReasoningText([item.summary, item.content, item.text]);
      if (itemText) return normalizeValReasoningText(itemText);
    }
  }
  for (const nested of [record.data, record.response]) {
    if (!isRecord(nested) || nested === record) continue;
    const nestedText = reasoningTextFromRecord(nested);
    if (nestedText) return nestedText;
  }
  return "";
}

function isReasoningStatusPlaceholder(text: string) {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.…!?:-]+$/g, "")
    .replace(/\s+/g, " ");
  return [
    "thinking",
    "reasoning",
    "analyzing",
    "analysing",
    "processing",
    "working",
    "starting reasoning",
    "reasoning started",
    "reasoning complete",
    "reasoning completed",
  ].includes(normalized);
}

export function reasoningTextFromStatus(record: Record<string, unknown>) {
  const marker = [
    record.type,
    record.action,
    record.stage,
    record.event,
    record.description,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (!/(reason|think)/.test(marker)) return "";
  const text =
    reasoningTextFromRecord(record) ||
    normalizeValReasoningText(
      firstReasoningText([
        record.content,
        record.text,
        record.summary,
        record.description,
      ]),
    );
  return isReasoningStatusPlaceholder(text) ? "" : text;
}

function nextReasoningTag(content: string, from: number) {
  const patterns: Array<{ expression: RegExp; closeTag: string }> = [
    {
      expression:
        /<details\b(?=[^>]*\btype\s*=\s*(?:"reasoning"|'reasoning'|reasoning)(?:\s|>|\/))[^>]*>/gi,
      closeTag: "</details>",
    },
    { expression: /<think\b[^>]*>/gi, closeTag: "</think>" },
    { expression: /<thinking\b[^>]*>/gi, closeTag: "</thinking>" },
    { expression: /<reasoning\b[^>]*>/gi, closeTag: "</reasoning>" },
  ];
  let next: { index: number; length: number; closeTag: string } | undefined;
  for (const pattern of patterns) {
    pattern.expression.lastIndex = from;
    const match = pattern.expression.exec(content);
    if (match && (!next || match.index < next.index)) {
      next = {
        index: match.index,
        length: match[0].length,
        closeTag: pattern.closeTag,
      };
    }
  }
  return next;
}

function withoutPartialReasoningTag(content: string, possibleTags: string[]) {
  const lower = content.toLowerCase();
  const lastOpening = lower.lastIndexOf("<");
  if (lastOpening < 0) return content;
  const suffix = lower.slice(lastOpening);
  if (
    possibleTags.some(
      (tag) =>
        tag.startsWith(suffix) ||
        (suffix.startsWith(tag) && !suffix.includes(">")),
    )
  ) {
    return content.slice(0, lastOpening);
  }
  return content;
}

function stripReasoningSummary(content: string) {
  return content.replace(/^\s*<summary\b[^>]*>[\s\S]*?<\/summary>\s*/i, "");
}

function withoutPartialClosingTag(content: string, closeTag: string) {
  const lastOpening = content.lastIndexOf("<");
  if (lastOpening < 0) return content;
  const compactSuffix = content
    .slice(lastOpening)
    .replace(/\s+/g, "")
    .toLowerCase();
  return compactSuffix && closeTag.startsWith(compactSuffix)
    ? content.slice(0, lastOpening)
    : content;
}

function normalizeReasoningContainer(content: string, closeTag: string) {
  return normalizeValReasoningText(
    stripReasoningSummary(withoutPartialClosingTag(content, closeTag)),
  ).trim();
}

function mergeReasoningContainer(current: string, incoming: string) {
  if (!incoming || incoming === current) return current;
  if (!current || incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  return `${current}\n${incoming}`;
}

export function splitValReasoningMarkup(rawContent: string) {
  let cursor = 0;
  let content = "";
  let reasoning = "";
  while (cursor < rawContent.length) {
    const opening = nextReasoningTag(rawContent, cursor);
    if (!opening) {
      content += withoutPartialReasoningTag(rawContent.slice(cursor), [
        "<details",
        "<think",
        "<thinking",
        "<reasoning",
      ]);
      break;
    }
    content += rawContent.slice(cursor, opening.index);
    const reasoningStart = opening.index + opening.length;
    const closingIndex = rawContent
      .toLowerCase()
      .indexOf(opening.closeTag, reasoningStart);
    const nestedOpening = nextReasoningTag(rawContent, reasoningStart);
    if (
      nestedOpening &&
      (closingIndex < 0 || nestedOpening.index < closingIndex)
    ) {
      reasoning = mergeReasoningContainer(
        reasoning,
        normalizeReasoningContainer(
          rawContent.slice(reasoningStart, nestedOpening.index),
          opening.closeTag,
        ),
      );
      cursor = nestedOpening.index;
      continue;
    }
    if (closingIndex < 0) {
      reasoning = mergeReasoningContainer(
        reasoning,
        normalizeReasoningContainer(
          withoutPartialReasoningTag(rawContent.slice(reasoningStart), [
            opening.closeTag,
          ]),
          opening.closeTag,
        ),
      );
      break;
    }
    reasoning = mergeReasoningContainer(
      reasoning,
      normalizeReasoningContainer(
        rawContent.slice(reasoningStart, closingIndex),
        opening.closeTag,
      ),
    );
    cursor = closingIndex + opening.closeTag.length;
  }
  return { content, reasoning };
}

function modelItemForExternalTools(
  modelItem: Record<string, unknown>,
  enabled: boolean,
) {
  if (!enabled) return modelItem;

  const info = isRecord(modelItem.info) ? modelItem.info : {};
  const params = isRecord(info.params) ? info.params : {};
  const meta = isRecord(info.meta) ? info.meta : {};
  const capabilities = isRecord(meta.capabilities) ? meta.capabilities : {};
  const builtinTools = isRecord(meta.builtinTools) ? meta.builtinTools : {};
  const disabledBuiltinTools = Object.fromEntries(
    [
      "automations",
      "calendar",
      "channels",
      "chats",
      "code_interpreter",
      "image_generation",
      "knowledge",
      "memory",
      "notes",
      "tasks",
      "time",
      "web_search",
    ].map((name) => [name, false]),
  );

  return {
    ...modelItem,
    info: {
      ...info,
      params: {
        ...params,
        function_calling: "indirect",
      },
      meta: {
        ...meta,
        capabilities: {
          ...capabilities,
          builtin_tools: false,
          web_search: false,
        },
        builtinTools: {
          ...builtinTools,
          ...disabledBuiltinTools,
        },
        knowledge: [],
        toolIds: [],
        filterIds: [],
        actionIds: [],
      },
    },
  };
}

export type ParsedClientToolCall = {
  name: string;
  arguments: string;
};

export type ValNativeToolTrace = {
  name?: string;
  internalId?: string;
};

const CLIENT_TOOL_OPEN = "<val_openai_tool_calls>";
const CLIENT_TOOL_CLOSE = "</val_openai_tool_calls>";
const CLIENT_TOOL_SERVER_ID = "val-openai-local-bridge";
const CLIENT_TOOL_SERVER_URL =
  "http://127.0.0.1/val-openai-local-bridge/client-tools";

function forcedToolName(toolChoice: RelayCompletionRequest["toolChoice"]) {
  if (!isRecord(toolChoice) || !isRecord(toolChoice.function)) return undefined;
  return typeof toolChoice.function.name === "string"
    ? toolChoice.function.name
    : undefined;
}

function clientToolDefinitions(
  tools: NonNullable<RelayCompletionRequest["tools"]>,
) {
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description
      ? { description: tool.function.description }
      : {}),
    parameters: tool.function.parameters ?? { type: "object" },
  }));
}

function clientToolServers(
  tools: NonNullable<RelayCompletionRequest["tools"]>,
) {
  return [
    {
      id: CLIENT_TOOL_SERVER_ID,
      name: "OpenAI API client tools",
      type: "openapi",
      auth_type: "none",
      url: CLIENT_TOOL_SERVER_URL,
      specs: clientToolDefinitions(tools),
    },
  ];
}

function clientToolInstruction(
  request: RelayCompletionRequest,
  tools: NonNullable<RelayCompletionRequest["tools"]>,
) {
  const forcedName = forcedToolName(request.toolChoice);
  const required = request.toolChoice === "required" || Boolean(forcedName);
  const definitions = clientToolDefinitions(tools);

  return [
    "Client-side function protocol (highest priority for tool behavior):",
    "Never call Val, RMIT, knowledge-base, chat-search, web-search, or other native functions.",
    "The supplied client function names are the only tools you may use. If they appear in the native function list, invoke the matching client function normally.",
    `If native client functions are unavailable, ask the API client to execute them by outputting exactly ${CLIENT_TOOL_OPEN}{"calls":[{"name":"function_name","arguments":{}}]}${CLIENT_TOOL_CLOSE} with valid JSON between the tags and no Markdown fence.`,
    `When emitting ${CLIENT_TOOL_OPEN}, the opening tag through ${CLIENT_TOOL_CLOSE} must be the entire response: do not put analysis, a preamble, progress text, or a final answer before or after it, and stop immediately after the closing tag.`,
    "If you already have enough information to answer, answer normally and do not emit a function envelope.",
    "Use only names from the supplied definitions and make arguments conform to their JSON schemas.",
    required
      ? `A client-side function call is required${forcedName ? ` and the function must be "${forcedName}"` : ""}; do not answer in prose.`
      : "When no client-side function is needed, answer normally without emitting the tags.",
    `Function definitions: ${JSON.stringify(definitions)}`,
  ].join(" ");
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&lt;|&#60;|&#x3c;/gi, "<")
    .replace(/&gt;|&#62;|&#x3e;/gi, ">")
    .replace(/&amp;|&#38;|&#x26;/gi, "&");
}

function tagAttribute(tag: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtmlAttribute(value);
}

export function findValNativeToolTraces(content: string): ValNativeToolTrace[] {
  const traces: ValNativeToolTrace[] = [];
  for (const match of content.matchAll(/<details\b[^>]*>/gi)) {
    const tag = match[0];
    if (tagAttribute(tag, "type")?.toLowerCase() !== "tool_calls") continue;
    const internalId =
      tagAttribute(tag, "internal_id") ?? tagAttribute(tag, "internal-id");
    const name = tagAttribute(tag, "name");
    traces.push({
      ...(name ? { name } : {}),
      ...(internalId ? { internalId } : {}),
    });
  }
  return traces;
}

function parseArguments(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "{}";
    JSON.parse(trimmed);
    return trimmed;
  }
  if (isRecord(value) || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  throw new Error(
    "Function arguments must be a JSON object, array, or encoded JSON string.",
  );
}

export function parseClientToolExecution(
  data: Record<string, unknown>,
  allowedToolNames: string[],
): ParsedClientToolCall {
  if (typeof data.name !== "string" || !data.name) {
    throw new Error("Val requested a client-side function without a name.");
  }
  if (!allowedToolNames.includes(data.name)) {
    throw new Error(`Val selected unavailable client function "${data.name}".`);
  }
  return {
    name: data.name,
    arguments: parseArguments(data.params ?? data.arguments ?? {}),
  };
}

export function isBridgeClientToolEvent(
  data: Record<string, unknown>,
  allowedToolNames: string[],
) {
  const server = isRecord(data.server) ? data.server : {};
  return (
    (server.id === CLIENT_TOOL_SERVER_ID ||
      server.url === CLIENT_TOOL_SERVER_URL) &&
    typeof data.name === "string" &&
    allowedToolNames.includes(data.name)
  );
}

export function parseClientToolCalls(
  content: string,
  allowedToolNames: string[],
): { content: string; toolCalls: ParsedClientToolCall[] } {
  const envelope = new RegExp(
    `${CLIENT_TOOL_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*([\\s\\S]*?)\\s*${CLIENT_TOOL_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "i",
  );
  const match = envelope.exec(content);
  let encoded = match?.[1]?.trim();
  let residualContent = content;
  if (match?.[0] !== undefined && match.index !== undefined) {
    const before = content
      .slice(0, match.index)
      .replace(/^\s*```(?:json)?\s*$/i, "")
      .trim();
    const after = content
      .slice(match.index + match[0].length)
      .replace(/^\s*```\s*$/i, "")
      .trim();
    residualContent = [before, after].filter(Boolean).join("\n\n");
  }
  if (!encoded) {
    const trimmed = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    if (
      trimmed.startsWith("{") &&
      trimmed.endsWith("}") &&
      /"calls?"\s*:/.test(trimmed)
    ) {
      encoded = trimmed;
      residualContent = "";
    }
  }
  if (!encoded) return { content, toolCalls: [] };

  const parsed = JSON.parse(encoded) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(
      "The client-side function envelope must contain a JSON object.",
    );
  }
  const rawCalls = Array.isArray(parsed.calls)
    ? parsed.calls
    : isRecord(parsed.call)
      ? [parsed.call]
      : [];
  if (rawCalls.length === 0) {
    throw new Error(
      "The client-side function envelope did not contain any calls.",
    );
  }

  const allowed = new Set(allowedToolNames);
  const seen = new Set<string>();
  const toolCalls: ParsedClientToolCall[] = [];
  for (const rawCall of rawCalls) {
    if (!isRecord(rawCall) || typeof rawCall.name !== "string") {
      throw new Error("Each client-side function call must have a name.");
    }
    if (!allowed.has(rawCall.name)) {
      throw new Error(
        `Val selected unavailable client function "${rawCall.name}".`,
      );
    }
    const argumentsValue = parseArguments(rawCall.arguments ?? {});
    const key = `${rawCall.name}\n${argumentsValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toolCalls.push({ name: rawCall.name, arguments: argumentsValue });
  }

  return {
    content: residualContent,
    toolCalls,
  };
}

export function resolveClientToolResponse(
  content: string,
  allowedToolNames: string[],
  toolChoice: RelayCompletionRequest["toolChoice"],
) {
  const parsed = parseClientToolCalls(content, allowedToolNames);
  const required =
    toolChoice === "required" || Boolean(forcedToolName(toolChoice));

  // An indirect function envelope is required to be the whole assistant turn.
  // If Val nevertheless appends an answer in auto mode, prefer that answer and
  // suppress the ambiguous function calls. This prevents OpenCode from
  // executing calls after the model has already produced a final response and
  // then recursively asking the model to continue.
  if (
    !required &&
    parsed.toolCalls.length > 0 &&
    parsed.content.trim().length > 0
  ) {
    return {
      content: parsed.content,
      toolCalls: [] as ParsedClientToolCall[],
    };
  }

  return {
    content: parsed.toolCalls.length > 0 ? "" : parsed.content,
    toolCalls: parsed.toolCalls,
  };
}

export function messageText(message: OpenAIMessage) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if ("text" in part) return part.text;
      if (part.type === "image_url" || part.type === "input_image")
        return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function storedMessagesToOpenAI(messages: unknown): OpenAIMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message): message is Record<string, unknown> =>
      Boolean(message && typeof message === "object"),
    )
    .filter((message) =>
      ["system", "developer", "user", "assistant", "tool"].includes(
        String(message.role),
      ),
    )
    .filter(
      (message) => !(message.role === "assistant" && message.done === false),
    )
    .map((message) => ({
      role: String(message.role) as OpenAIMessage["role"],
      content: typeof message.content === "string" ? message.content : "",
      ...(typeof message.tool_call_id === "string"
        ? { tool_call_id: message.tool_call_id }
        : {}),
      ...(Array.isArray(message.tool_calls)
        ? { tool_calls: message.tool_calls as OpenAIToolCall[] }
        : {}),
    }));
}

export function buildValHistory(
  messages: OpenAIMessage[],
  model: string,
  now = Math.floor(Date.now() / 1000),
): BuiltHistory {
  const historyMessages: Record<string, ValHistoryMessage> = {};
  const list: ValHistoryMessage[] = [];
  let parentId: string | null = null;

  for (const message of messages) {
    const id = randomUUID();
    const item: ValHistoryMessage = {
      id,
      parentId,
      childrenIds: [],
      role: message.role,
      content: messageText(message),
      timestamp: now,
      ...(message.role === "assistant" ? { model, done: true } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
    if (parentId) historyMessages[parentId]?.childrenIds.push(id);
    historyMessages[id] = item;
    list.push(item);
    parentId = id;
  }

  const assistantMessageId = randomUUID();
  const assistant: ValHistoryMessage = {
    id: assistantMessageId,
    parentId,
    childrenIds: [],
    role: "assistant",
    content: "",
    timestamp: now,
    model,
    done: false,
  };
  if (parentId) historyMessages[parentId]?.childrenIds.push(assistantMessageId);
  historyMessages[assistantMessageId] = assistant;
  list.push(assistant);

  return {
    history: {
      currentId: assistantMessageId,
      messages: historyMessages,
    },
    messages: list,
    assistantMessageId,
  };
}

export function completionPayload(
  request: RelayCompletionRequest,
  modelItem: Record<string, unknown>,
  sessionId: string,
  chatId: string,
  assistantMessageId: string,
  messages: OpenAIMessage[],
) {
  const toolChoice = request.toolChoice;
  const toolChoiceIsNone = toolChoice === "none";
  const tools = toolChoiceIsNone ? undefined : request.tools;
  const systemInstructions = tools?.length
    ? [clientToolInstruction(request, tools)]
    : [];
  const outgoingMessages =
    systemInstructions.length > 0
      ? [
          ...systemInstructions.map((content) => ({
            role: "system" as const,
            content,
          })),
          ...messages,
        ]
      : messages;
  const params: JsonObject = {
    ...(request.parameters ?? {}),
    ...(tools
      ? {
          function_calling: "indirect",
        }
      : {}),
  };

  return {
    stream: true,
    model: request.model,
    messages: outgoingMessages,
    params,
    ...(tools ? { tool_ids: [] } : {}),
    ...(tools ? { tool_servers: clientToolServers(tools) } : {}),
    ...(request.responseFormat !== undefined
      ? { response_format: request.responseFormat }
      : {}),
    features: {
      image_generation: false,
      code_interpreter: false,
      web_search: false,
    },
    variables: {},
    model_item: modelItemForExternalTools(modelItem, Boolean(tools)),
    stream_options: { include_usage: true },
    session_id: sessionId,
    chat_id: chatId,
    id: assistantMessageId,
  };
}
