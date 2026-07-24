import type {
  JsonObject,
  JsonValue,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAITool,
  OpenAIToolCall,
  RelayCompletionRequest,
} from "@val-bridge/protocol";
import { z } from "zod";
import { OpenAIHttpError } from "./errors.js";

const contentPartSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const messageSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z
      .union([z.string(), z.array(contentPartSchema), z.null()])
      .optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
  })
  .passthrough();

const toolSchema = z
  .object({
    type: z.string(),
    function: z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        parameters: z.record(z.unknown()).optional(),
        strict: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const chatCompletionSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional().default(false),
    store: z.boolean().optional().default(false),
    metadata: z.record(z.unknown()).optional(),
    tools: z.array(toolSchema).optional(),
    tool_choice: z.unknown().optional(),
    response_format: z.unknown().optional(),
    n: z.number().int().positive().optional(),
    modalities: z.array(z.string()).optional(),
    audio: z.unknown().optional(),
    stream_options: z
      .object({
        include_usage: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionSchema>;

export const responseSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.unknown())]),
    instructions: z.string().optional(),
    stream: z.boolean().optional().default(false),
    store: z.boolean().optional().default(false),
    previous_response_id: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    text: z
      .object({
        format: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z.unknown().optional(),
    truncation: z.unknown().optional(),
  })
  .passthrough();

export type ResponseRequest = z.infer<typeof responseSchema>;

function invalidRequest(code: string, message: string, param?: string): never {
  throw new OpenAIHttpError(
    400,
    code,
    message,
    "invalid_request_error",
    param ?? null,
  );
}

function validateContentParts(messages: Array<Record<string, unknown>>) {
  const supported = new Set([
    "text",
    "input_text",
    "output_text",
    "image_url",
    "input_image",
  ]);
  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    for (const [partIndex, rawPart] of message.content.entries()) {
      const part = rawPart as Record<string, unknown>;
      if (!supported.has(String(part.type))) {
        invalidRequest(
          "unsupported_feature",
          `Message content type "${String(part.type)}" is not supported by Val.`,
          `messages.${messageIndex}.content.${partIndex}.type`,
        );
      }
      if (part.type === "input_image" && part.file_id) {
        invalidRequest(
          "unsupported_feature",
          "Input images must use image_url; OpenAI file IDs are not available through Val.",
          `messages.${messageIndex}.content.${partIndex}.file_id`,
        );
      }
    }
  }
}

export function parseChatCompletion(input: unknown): ChatCompletionRequest {
  const parsed = chatCompletionSchema.safeParse(input);
  if (!parsed.success) {
    throw new OpenAIHttpError(
      400,
      "invalid_request",
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  if ((parsed.data.n ?? 1) !== 1) {
    invalidRequest("unsupported_feature", "Only n=1 is supported.", "n");
  }
  if (
    parsed.data.audio ||
    parsed.data.modalities?.some((modality) => modality !== "text")
  ) {
    invalidRequest(
      "unsupported_feature",
      "Audio output is not available through this chat bridge.",
      "modalities",
    );
  }
  validateContentParts(parsed.data.messages as Array<Record<string, unknown>>);
  if (parsed.data.tools?.some((tool) => tool.type !== "function")) {
    invalidRequest(
      "unsupported_feature",
      "Only OpenAI function tools are supported.",
      "tools",
    );
  }
  return parsed.data;
}

export function parseResponse(input: unknown): ResponseRequest {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) {
    throw new OpenAIHttpError(
      400,
      "invalid_request",
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

function asJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return value as JsonValue;
}

function selectParameters(body: Record<string, unknown>): JsonObject {
  const names = [
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "stop",
    "reasoning_effort",
    "verbosity",
    "service_tier",
    "parallel_tool_calls",
    "logit_bias",
    "logprobs",
    "top_logprobs",
  ];
  const parameters: JsonObject = {};
  for (const name of names) {
    const value = asJsonValue(body[name]);
    if (value !== undefined) {
      parameters[name] = value;
    }
  }
  return parameters;
}

export function chatRequestToRelay(
  body: ChatCompletionRequest,
  persistence:
    | { mode: "temporary" }
    | {
        mode: "stored";
        chatId?: string;
        appendToExisting?: boolean;
        title?: string;
      },
): RelayCompletionRequest {
  return {
    kind: "completion",
    model: body.model,
    messages: body.messages as OpenAIMessage[],
    parameters: selectParameters(body),
    ...(body.tools ? { tools: body.tools as OpenAITool[] } : {}),
    ...(body.tool_choice !== undefined
      ? { toolChoice: body.tool_choice as JsonValue }
      : {}),
    ...(body.response_format !== undefined
      ? { responseFormat: body.response_format as JsonValue }
      : {}),
    persistence,
  };
}

function responseContentToMessageContent(
  content: unknown,
): string | OpenAIContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: OpenAIContentPart[] = [];
  for (const rawPart of content) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as Record<string, unknown>;
    if (part.type === "input_text" || part.type === "output_text") {
      parts.push({ type: "text", text: String(part.text ?? "") });
    } else if (part.type === "input_image") {
      if (part.file_id) {
        invalidRequest(
          "unsupported_feature",
          "Responses input images must use image_url; file IDs are not available through Val.",
          "input",
        );
      }
      parts.push({
        type: "image_url",
        image_url: String(part.image_url ?? ""),
      });
    }
  }
  return parts;
}

export function responseInputToMessages(
  body: ResponseRequest,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  if (body.instructions) {
    messages.push({ role: "developer", content: body.instructions });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
    return messages;
  }

  let pendingToolCalls: OpenAIToolCall[] = [];
  let pendingToolOutputs: OpenAIMessage[] = [];
  const flushToolExchange = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: pendingToolCalls,
      });
    }
    messages.push(...pendingToolOutputs);
    pendingToolCalls = [];
    pendingToolOutputs = [];
  };

  for (const rawItem of body.input) {
    if (!rawItem || typeof rawItem !== "object") {
      invalidRequest(
        "invalid_input",
        "Responses input items must be objects.",
        "input",
      );
    }
    const item = rawItem as Record<string, unknown>;
    if (item.type === "message" || typeof item.role === "string") {
      flushToolExchange();
      const role = String(item.role ?? "user");
      if (
        !["system", "developer", "user", "assistant", "tool"].includes(role)
      ) {
        invalidRequest(
          "invalid_input",
          `Unsupported message role "${role}".`,
          "input",
        );
      }
      messages.push({
        role: role as OpenAIMessage["role"],
        content: responseContentToMessageContent(item.content),
      });
    } else if (item.type === "function_call_output") {
      pendingToolOutputs.push({
        role: "tool",
        tool_call_id: String(item.call_id ?? ""),
        content:
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output ?? null),
      });
    } else if (item.type === "function_call") {
      pendingToolCalls.push({
        id: String(item.call_id ?? item.id ?? ""),
        type: "function",
        function: {
          name: String(item.name ?? ""),
          arguments: String(item.arguments ?? ""),
        },
      });
    } else if (item.type === "reasoning") {
      // Responses reasoning items have no Chat Completions equivalent. They
      // describe the prior model turn and can be omitted when reconstructing
      // the assistant/tool exchange for Val.
      continue;
    } else {
      invalidRequest(
        "unsupported_feature",
        `Responses input item type "${String(item.type)}" is not supported.`,
        "input",
      );
    }
  }
  flushToolExchange();
  return messages;
}

export function responseToolsToChatTools(
  rawTools: unknown[] | undefined,
): OpenAITool[] | undefined {
  if (!rawTools) return undefined;
  const tools: OpenAITool[] = [];
  for (const rawTool of rawTools) {
    if (!rawTool || typeof rawTool !== "object") {
      invalidRequest(
        "invalid_tools",
        "Tool definitions must be objects.",
        "tools",
      );
    }
    const tool = rawTool as Record<string, unknown>;
    if (tool.type !== "function") {
      invalidRequest(
        "unsupported_feature",
        `Responses tool type "${String(tool.type)}" is not available through Val.`,
        "tools",
      );
    }
    tools.push({
      type: "function",
      function: {
        name: String(tool.name ?? ""),
        ...(typeof tool.description === "string"
          ? { description: tool.description }
          : {}),
        ...(tool.parameters && typeof tool.parameters === "object"
          ? { parameters: tool.parameters as JsonObject }
          : {}),
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      },
    });
  }
  return tools;
}

export function responseRequestToRelay(
  body: ResponseRequest,
  persistence:
    | { mode: "temporary" }
    | {
        mode: "stored";
        chatId?: string;
        appendToExisting?: boolean;
        title?: string;
      },
): RelayCompletionRequest {
  const parameters: JsonObject = {};
  if (body.temperature !== undefined) parameters.temperature = body.temperature;
  if (body.top_p !== undefined) parameters.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) {
    parameters.max_completion_tokens = body.max_output_tokens;
  }
  if (body.parallel_tool_calls !== undefined) {
    parameters.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (typeof body.reasoning === "string") {
    parameters.reasoning_effort = body.reasoning;
  } else if (
    body.reasoning &&
    typeof body.reasoning === "object" &&
    !Array.isArray(body.reasoning)
  ) {
    const reasoning = body.reasoning as Record<string, unknown>;
    if (typeof reasoning.effort === "string") {
      parameters.reasoning_effort = reasoning.effort;
    }
    if (typeof reasoning.summary === "string") {
      parameters.reasoning_summary = reasoning.summary;
    }
  }
  if (body.truncation !== undefined)
    parameters.truncation = body.truncation as JsonValue;

  const tools = responseToolsToChatTools(body.tools);
  return {
    kind: "completion",
    model: body.model,
    messages: responseInputToMessages(body),
    parameters,
    ...(tools ? { tools } : {}),
    ...(body.tool_choice !== undefined
      ? { toolChoice: body.tool_choice as JsonValue }
      : {}),
    ...(body.text?.format !== undefined
      ? { responseFormat: body.text.format as JsonValue }
      : {}),
    persistence,
  };
}

export function messageText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if ("text" in part) return part.text;
      if (part.type === "image_url" || part.type === "input_image")
        return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function titleFromMessages(messages: OpenAIMessage[]) {
  const firstUser = messages.find((message) => message.role === "user");
  const text = messageText(firstUser?.content).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 80) : "API Chat";
}
