import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  OpenAIToolCall,
  ValRelayEvent,
} from "@val-bridge/protocol";
import {
  assistantTextFromContent,
  reasoningTextFromRecord,
  reasoningTextFromStatus,
  splitValReasoningMarkup,
} from "./reasoning.js";

export type ChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: JsonObject | null;
};

type MutableToolCall = {
  id: string;
  type: "function";
  argumentReplay?: string;
  function: {
    name: string;
    arguments: string;
  };
};

function textFromUnknown(value: unknown) {
  return assistantTextFromContent(value);
}

function mergeStreamFragment(current: string, incoming: string) {
  if (!incoming || incoming === current) {
    return { value: current, delta: "" };
  }
  if (incoming.startsWith(current)) {
    return { value: incoming, delta: incoming.slice(current.length) };
  }
  return { value: current + incoming, delta: incoming };
}

function mergeArgumentFragment(tool: MutableToolCall, incoming: string) {
  const current = tool.function.arguments;
  if (!incoming || incoming === current) return "";

  if (tool.argumentReplay !== undefined) {
    const candidate = tool.argumentReplay + incoming;
    if (current.startsWith(candidate)) {
      tool.argumentReplay = candidate === current ? undefined : candidate;
      return "";
    }
    if (candidate.startsWith(current)) {
      const delta = candidate.slice(current.length);
      tool.function.arguments = candidate;
      tool.argumentReplay = undefined;
      return delta;
    }
    tool.function.arguments += candidate;
    tool.argumentReplay = undefined;
    return candidate;
  }

  if (incoming.startsWith(current)) {
    const delta = incoming.slice(current.length);
    tool.function.arguments = incoming;
    return delta;
  }
  if (current.startsWith(incoming)) {
    tool.argumentReplay = incoming;
    return "";
  }
  tool.function.arguments += incoming;
  return incoming;
}

function collapseRepeatedJson(value: string) {
  for (let length = 1; length <= value.length / 2; length += 1) {
    if (value.length % length !== 0) continue;
    const candidate = value.slice(0, length);
    if (candidate.repeat(value.length / length) !== value) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Continue looking for a larger valid JSON period.
    }
  }
  return value;
}

export class ChatAccumulator {
  readonly id: string;
  readonly created: number;
  private rawContentValue = "";
  private contentValue = "";
  private reasoningValue = "";
  private readonly toolCallsValue = new Map<number, MutableToolCall>();
  private usageValue?: JsonObject;
  private finishReasonValue: string | null = null;
  private started = false;

  constructor(
    readonly model: string,
    options: { id?: string; created?: number } = {},
  ) {
    this.id = options.id ?? `chatcmpl_${randomUUID().replaceAll("-", "")}`;
    this.created = options.created ?? Math.floor(Date.now() / 1000);
  }

  get content() {
    return this.contentValue;
  }

  get reasoning() {
    return this.reasoningValue;
  }

  get usage() {
    return this.usageValue;
  }

  get finishReason() {
    if (
      this.toolCallsValue.size > 0 &&
      (this.finishReasonValue === null ||
        this.finishReasonValue === "stop" ||
        this.finishReasonValue === "function_call")
    ) {
      return "tool_calls";
    }
    return this.finishReasonValue ?? "stop";
  }

  get toolCalls(): OpenAIToolCall[] {
    return [...this.toolCallsValue.entries()]
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

  consume(event: ValRelayEvent): ChatCompletionChunk[] {
    if (event.kind === "error") return [];
    if (event.kind === "status") {
      const reasoning = reasoningTextFromStatus(
        event.data as Record<string, unknown>,
      );
      return this.mergeReasoning(reasoning);
    }
    if (event.kind === "usage") {
      this.usageValue = event.usage;
      return [];
    }
    if (event.kind === "delta") {
      if (!event.content) return [];
      const merged = mergeStreamFragment(this.rawContentValue, event.content);
      this.rawContentValue = merged.value;
      return this.applyParsedContent();
    }
    if (event.kind === "replace") {
      this.rawContentValue = event.content;
      return this.applyParsedContent();
    }

    const data = event.data as Record<string, unknown>;
    if (data.usage && typeof data.usage === "object") {
      this.usageValue = data.usage as JsonObject;
    }
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const emitted: ChatCompletionChunk[] = [];

    if (choices.length === 0) {
      const reasoning = reasoningTextFromRecord(data);
      emitted.push(...this.mergeReasoning(reasoning));
    }

    for (const rawChoice of choices.slice(0, 1)) {
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

      const outgoingDelta: Record<string, unknown> = {};
      const reasoning =
        reasoningTextFromRecord(delta) ||
        reasoningTextFromRecord(message) ||
        reasoningTextFromRecord(choice);
      if (reasoning) {
        const merged = mergeStreamFragment(this.reasoningValue, reasoning);
        this.reasoningValue = merged.value;
        if (merged.delta) {
          outgoingDelta.reasoning_content = merged.delta;
        }
      }

      const content = textFromUnknown(delta?.content ?? message?.content);
      if (content) {
        const merged = mergeStreamFragment(this.rawContentValue, content);
        this.rawContentValue = merged.value;
        const parsedDelta = this.reconcileParsedContent();
        Object.assign(outgoingDelta, parsedDelta);
      }

      let rawToolCalls = (delta?.tool_calls ?? message?.tool_calls) as unknown;
      const legacyFunctionCall = delta?.function_call ?? message?.function_call;
      if (
        !Array.isArray(rawToolCalls) &&
        legacyFunctionCall &&
        typeof legacyFunctionCall === "object"
      ) {
        rawToolCalls = [
          {
            index: 0,
            type: "function",
            function: legacyFunctionCall,
          },
        ];
      }
      if (Array.isArray(rawToolCalls)) {
        const outgoingToolCalls: Array<Record<string, unknown>> = [];
        for (const [fallbackIndex, rawTool] of rawToolCalls.entries()) {
          if (!rawTool || typeof rawTool !== "object") continue;
          const tool = rawTool as Record<string, unknown>;
          const index = this.resolveToolIndex(tool, fallbackIndex);
          const functionPart =
            tool.function && typeof tool.function === "object"
              ? (tool.function as Record<string, unknown>)
              : {};
          const isNew = !this.toolCallsValue.has(index);
          const existing = this.toolCallsValue.get(index) ?? {
            id:
              typeof tool.id === "string"
                ? tool.id
                : `call_${randomUUID().replaceAll("-", "")}`,
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          const previousId = existing.id;
          if (typeof tool.id === "string") existing.id = tool.id;
          let nameDelta = "";
          if (typeof functionPart.name === "string") {
            const merged = mergeStreamFragment(
              existing.function.name,
              functionPart.name,
            );
            existing.function.name = merged.value;
            nameDelta = merged.delta;
          }
          let argumentsDelta = "";
          if (typeof functionPart.arguments === "string") {
            argumentsDelta = mergeArgumentFragment(
              existing,
              functionPart.arguments,
            );
          }
          this.toolCallsValue.set(index, existing);
          const outgoingToolCall: Record<string, unknown> = {
            index,
          };
          if (
            isNew ||
            (typeof tool.id === "string" && tool.id !== previousId)
          ) {
            outgoingToolCall.id = existing.id;
          }
          if (isNew) {
            outgoingToolCall.type = tool.type ?? "function";
          }
          if (nameDelta || argumentsDelta) {
            outgoingToolCall.function = {
              ...(nameDelta ? { name: nameDelta } : {}),
              ...(argumentsDelta ? { arguments: argumentsDelta } : {}),
            };
          }
          if (Object.keys(outgoingToolCall).length > 1) {
            outgoingToolCalls.push(outgoingToolCall);
          }
        }
        if (outgoingToolCalls.length > 0)
          outgoingDelta.tool_calls = outgoingToolCalls;
      }

      if (typeof choice.finish_reason === "string") {
        this.finishReasonValue =
          choice.finish_reason === "function_call"
            ? "tool_calls"
            : choice.finish_reason;
      }
      if (Object.keys(outgoingDelta).length > 0 || choice.finish_reason) {
        emitted.push(this.deltaChunk(outgoingDelta, this.finishReasonValue));
      }
    }
    return emitted;
  }

  finishChunk(includeUsage: boolean): ChatCompletionChunk {
    const chunk = this.deltaChunk({}, this.finishReason);
    if (includeUsage) {
      chunk.usage = this.usageValue ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
    }
    return chunk;
  }

  completion() {
    return {
      id: this.id,
      object: "chat.completion" as const,
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: this.contentValue || null,
            ...(this.reasoningValue
              ? { reasoning_content: this.reasoningValue }
              : {}),
            ...(this.toolCalls.length > 0
              ? {
                  tool_calls: this.toolCalls.map(
                    ({ index: _index, ...toolCall }) => toolCall,
                  ),
                }
              : {}),
          },
          finish_reason: this.finishReason,
        },
      ],
      usage: this.usageValue ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  private deltaChunk(
    delta: Record<string, unknown>,
    finishReason: string | null = null,
  ): ChatCompletionChunk {
    const outgoingDelta = {
      ...(!this.started ? { role: "assistant" } : {}),
      ...delta,
    };
    this.started = true;
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: outgoingDelta,
          finish_reason: finishReason,
        },
      ],
    };
  }

  private applyParsedContent() {
    const delta = this.reconcileParsedContent();
    return Object.keys(delta).length > 0 ? [this.deltaChunk(delta)] : [];
  }

  private reconcileParsedContent() {
    const parsed = splitValReasoningMarkup(this.rawContentValue);
    const outgoingDelta: Record<string, unknown> = {};

    const content = mergeStreamFragment(this.contentValue, parsed.content);
    this.contentValue = content.value;
    if (content.delta) outgoingDelta.content = content.delta;

    const reasoning = mergeStreamFragment(
      this.reasoningValue,
      parsed.reasoning,
    );
    this.reasoningValue = reasoning.value;
    if (reasoning.delta) {
      outgoingDelta.reasoning_content = reasoning.delta;
    }
    return outgoingDelta;
  }

  private mergeReasoning(reasoning: string) {
    if (!reasoning) return [];
    const merged = mergeStreamFragment(this.reasoningValue, reasoning);
    this.reasoningValue = merged.value;
    return merged.delta
      ? [this.deltaChunk({ reasoning_content: merged.delta })]
      : [];
  }

  private resolveToolIndex(
    tool: Record<string, unknown>,
    fallbackIndex: number,
  ) {
    const id = typeof tool.id === "string" && tool.id ? tool.id : undefined;
    if (id) {
      for (const [index, existing] of this.toolCallsValue) {
        if (existing.id === id) return index;
      }
    }

    let index = typeof tool.index === "number" ? tool.index : fallbackIndex;
    const existing = this.toolCallsValue.get(index);
    if (id && existing && existing.id !== id) {
      index = 0;
      while (this.toolCallsValue.has(index)) index += 1;
    }
    return index;
  }
}
