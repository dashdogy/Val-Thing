import { randomUUID } from "node:crypto";
import type { OpenAIToolCall } from "@val-bridge/protocol";
import type {
  ChatCompletionChunk,
  ChatAccumulator,
} from "./chat-accumulator.js";
import type { ResponseRequest } from "./openai-schema.js";

type ResponseEvent = Record<string, unknown> & {
  type: string;
  sequence_number: number;
};

function cleanToolCalls(toolCalls: OpenAIToolCall[]) {
  return toolCalls.map(({ index: _index, ...toolCall }) => toolCall);
}

export class ResponsesAdapter {
  readonly id: string;
  readonly messageId: string;
  readonly reasoningItemId: string;
  private sequence = 0;
  private nextOutputIndex = 0;
  private reasoningOutputIndex?: number;
  private reasoningItemAdded = false;
  private reasoningPartAdded = false;
  private textOutputIndex?: number;
  private textItemAdded = false;
  private textPartAdded = false;
  private readonly toolItemIds = new Map<number, string>();
  private readonly toolOutputIndexes = new Map<number, number>();

  constructor(
    readonly request: ResponseRequest,
    readonly accumulator: ChatAccumulator,
    options: { id?: string } = {},
  ) {
    this.id = options.id ?? `resp_${randomUUID().replaceAll("-", "")}`;
    this.messageId = `msg_${randomUUID().replaceAll("-", "")}`;
    this.reasoningItemId = `rs_${randomUUID().replaceAll("-", "")}`;
  }

  initialEvents(): ResponseEvent[] {
    const response = this.responseObject("in_progress");
    return [
      this.event("response.created", { response }),
      this.event("response.in_progress", { response }),
    ];
  }

  eventsFromChunk(chunk: ChatCompletionChunk): ResponseEvent[] {
    const events: ResponseEvent[] = [];
    const delta = chunk.choices[0]?.delta ?? {};
    const reasoning =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : "";
    const content = typeof delta.content === "string" ? delta.content : "";

    if (reasoning) {
      events.push(...this.ensureReasoningOutput());
      events.push(
        this.event("response.reasoning_summary_text.delta", {
          item_id: this.reasoningItemId,
          output_index: this.reasoningIndex(),
          summary_index: 0,
          delta: reasoning,
        }),
      );
    }

    if (content) {
      events.push(...this.ensureTextOutput());
      events.push(
        this.event("response.output_text.delta", {
          item_id: this.messageId,
          output_index: this.textIndex(),
          content_index: 0,
          delta: content,
          logprobs: [],
        }),
      );
    }

    const toolDeltas = Array.isArray(delta.tool_calls)
      ? (delta.tool_calls as Array<Record<string, unknown>>)
      : [];
    for (const [fallbackIndex, toolDelta] of toolDeltas.entries()) {
      const index =
        typeof toolDelta.index === "number" ? toolDelta.index : fallbackIndex;
      const functionPart =
        toolDelta.function && typeof toolDelta.function === "object"
          ? (toolDelta.function as Record<string, unknown>)
          : {};
      let itemId = this.toolItemIds.get(index);
      if (!itemId) {
        const current = this.accumulator.toolCalls.find(
          (tool) => tool.index === index,
        );
        itemId = `fc_${randomUUID().replaceAll("-", "")}`;
        this.toolItemIds.set(index, itemId);
        events.push(
          this.event("response.output_item.added", {
            output_index: this.toolIndex(index),
            item: {
              id: itemId,
              type: "function_call",
              status: "in_progress",
              arguments: "",
              call_id: current?.id ?? String(toolDelta.id ?? ""),
              name: current?.function.name ?? String(functionPart.name ?? ""),
            },
          }),
        );
      }
      if (
        typeof functionPart.arguments === "string" &&
        functionPart.arguments
      ) {
        events.push(
          this.event("response.function_call_arguments.delta", {
            item_id: itemId,
            output_index: this.toolIndex(index),
            delta: functionPart.arguments,
          }),
        );
      }
    }
    return events;
  }

  finalEvents(): ResponseEvent[] {
    const events: ResponseEvent[] = [];
    if (this.accumulator.reasoning) {
      events.push(...this.ensureReasoningOutput());
      events.push(
        this.event("response.reasoning_summary_text.done", {
          item_id: this.reasoningItemId,
          output_index: this.reasoningIndex(),
          summary_index: 0,
          text: this.accumulator.reasoning,
        }),
        this.event("response.reasoning_summary_part.done", {
          item_id: this.reasoningItemId,
          output_index: this.reasoningIndex(),
          summary_index: 0,
          part: {
            type: "summary_text",
            text: this.accumulator.reasoning,
          },
        }),
        this.event("response.output_item.done", {
          output_index: this.reasoningIndex(),
          item: this.reasoningItem("completed"),
        }),
      );
    }

    if (this.textPartAdded) {
      events.push(
        this.event("response.output_text.done", {
          item_id: this.messageId,
          output_index: this.textIndex(),
          content_index: 0,
          text: this.accumulator.content,
          logprobs: [],
        }),
        this.event("response.content_part.done", {
          item_id: this.messageId,
          output_index: this.textIndex(),
          content_index: 0,
          part: {
            type: "output_text",
            text: this.accumulator.content,
            annotations: [],
            logprobs: [],
          },
        }),
        this.event("response.output_item.done", {
          output_index: this.textIndex(),
          item: this.messageItem("completed"),
        }),
      );
    }

    for (const toolCall of this.accumulator.toolCalls) {
      const index = toolCall.index ?? 0;
      const itemId =
        this.toolItemIds.get(index) ?? `fc_${randomUUID().replaceAll("-", "")}`;
      const outputIndex = this.toolIndex(index);
      if (!this.toolItemIds.has(index)) {
        this.toolItemIds.set(index, itemId);
        events.push(
          this.event("response.output_item.added", {
            output_index: outputIndex,
            item: {
              id: itemId,
              type: "function_call",
              status: "in_progress",
              arguments: "",
              call_id: toolCall.id,
              name: toolCall.function.name,
            },
          }),
        );
      }
      events.push(
        this.event("response.function_call_arguments.done", {
          item_id: itemId,
          output_index: outputIndex,
          arguments: toolCall.function.arguments,
        }),
        this.event("response.output_item.done", {
          output_index: outputIndex,
          item: {
            id: itemId,
            type: "function_call",
            status: "completed",
            arguments: toolCall.function.arguments,
            call_id: toolCall.id,
            name: toolCall.function.name,
          },
        }),
      );
    }

    events.push(
      this.event("response.completed", {
        response: this.responseObject("completed"),
      }),
    );
    return events;
  }

  errorEvents(error: {
    code: string;
    message: string;
    param?: string | null;
  }): ResponseEvent[] {
    return [
      this.event("error", {
        code: error.code,
        message: error.message,
        param: error.param ?? null,
      }),
    ];
  }

  responseObject(status: "in_progress" | "completed" = "completed") {
    const output: Array<{
      index: number;
      item: Record<string, unknown>;
    }> = [];
    if (this.accumulator.reasoning) {
      output.push({
        index: this.reasoningIndex(),
        item: this.reasoningItem(status),
      });
    }
    if (
      this.accumulator.content ||
      (status === "completed" && this.accumulator.toolCalls.length === 0)
    ) {
      output.push({
        index: this.textIndex(),
        item: this.messageItem(status),
      });
    }
    for (const toolCall of this.accumulator.toolCalls) {
      const index = toolCall.index ?? 0;
      let itemId = this.toolItemIds.get(index);
      if (!itemId) {
        itemId = `fc_${randomUUID().replaceAll("-", "")}`;
        this.toolItemIds.set(index, itemId);
      }
      output.push({
        index: this.toolIndex(index),
        item: {
          id: itemId,
          type: "function_call",
          status,
          arguments: toolCall.function.arguments,
          call_id: toolCall.id,
          name: toolCall.function.name,
        },
      });
    }

    const usage = this.accumulator.usage as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        }
      | undefined;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    const completionDetails =
      usage && "completion_tokens_details" in usage
        ? usage.completion_tokens_details
        : undefined;
    const outputDetails =
      usage && "output_tokens_details" in usage
        ? usage.output_tokens_details
        : undefined;
    const reasoningTokens =
      completionDetails &&
      typeof completionDetails === "object" &&
      typeof (completionDetails as { reasoning_tokens?: unknown })
        .reasoning_tokens === "number"
        ? (completionDetails as { reasoning_tokens: number }).reasoning_tokens
        : outputDetails &&
            typeof outputDetails === "object" &&
            typeof (outputDetails as { reasoning_tokens?: unknown })
              .reasoning_tokens === "number"
          ? (outputDetails as { reasoning_tokens: number }).reasoning_tokens
          : 0;

    return {
      id: this.id,
      object: "response",
      created_at: this.accumulator.created,
      status,
      background: false,
      error: null,
      incomplete_details: null,
      instructions: this.request.instructions ?? null,
      max_output_tokens: this.request.max_output_tokens ?? null,
      model: this.request.model,
      output: output
        .sort((left, right) => left.index - right.index)
        .map(({ item }) => item),
      parallel_tool_calls: this.request.parallel_tool_calls ?? true,
      previous_response_id: this.request.previous_response_id ?? null,
      reasoning: this.request.reasoning ?? null,
      store: this.request.store,
      temperature: this.request.temperature ?? null,
      text: this.request.text ?? { format: { type: "text" } },
      tool_choice: this.request.tool_choice ?? "auto",
      tools: this.request.tools ?? [],
      top_p: this.request.top_p ?? null,
      truncation: this.request.truncation ?? "disabled",
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: reasoningTokens },
        total_tokens: usage?.total_tokens ?? inputTokens + outputTokens,
      },
      metadata: this.request.metadata ?? {},
    };
  }

  private ensureTextOutput(): ResponseEvent[] {
    const events: ResponseEvent[] = [];
    if (!this.textItemAdded) {
      this.textItemAdded = true;
      events.push(
        this.event("response.output_item.added", {
          output_index: this.textIndex(),
          item: this.messageItem("in_progress", []),
        }),
      );
    }
    if (!this.textPartAdded) {
      this.textPartAdded = true;
      events.push(
        this.event("response.content_part.added", {
          item_id: this.messageId,
          output_index: this.textIndex(),
          content_index: 0,
          part: {
            type: "output_text",
            text: "",
            annotations: [],
            logprobs: [],
          },
        }),
      );
    }
    return events;
  }

  private ensureReasoningOutput(): ResponseEvent[] {
    const events: ResponseEvent[] = [];
    if (!this.reasoningItemAdded) {
      this.reasoningItemAdded = true;
      events.push(
        this.event("response.output_item.added", {
          output_index: this.reasoningIndex(),
          item: this.reasoningItem("in_progress", []),
        }),
      );
    }
    if (!this.reasoningPartAdded) {
      this.reasoningPartAdded = true;
      events.push(
        this.event("response.reasoning_summary_part.added", {
          item_id: this.reasoningItemId,
          output_index: this.reasoningIndex(),
          summary_index: 0,
          part: {
            type: "summary_text",
            text: "",
          },
        }),
      );
    }
    return events;
  }

  private messageItem(
    status: "in_progress" | "completed",
    content: Array<Record<string, unknown>> = [
      {
        type: "output_text",
        text: this.accumulator.content,
        annotations: [],
        logprobs: [],
      },
    ],
  ) {
    return {
      id: this.messageId,
      type: "message",
      status,
      role: "assistant",
      content,
    };
  }

  private reasoningItem(
    status: "in_progress" | "completed",
    summary: Array<Record<string, unknown>> = this.accumulator.reasoning
      ? [
          {
            type: "summary_text",
            text: this.accumulator.reasoning,
          },
        ]
      : [],
  ) {
    return {
      id: this.reasoningItemId,
      type: "reasoning",
      status,
      summary,
    };
  }

  private allocateOutputIndex() {
    return this.nextOutputIndex++;
  }

  private reasoningIndex() {
    this.reasoningOutputIndex ??= this.allocateOutputIndex();
    return this.reasoningOutputIndex;
  }

  private textIndex() {
    this.textOutputIndex ??= this.allocateOutputIndex();
    return this.textOutputIndex;
  }

  private toolIndex(index: number) {
    let outputIndex = this.toolOutputIndexes.get(index);
    if (outputIndex === undefined) {
      outputIndex = this.allocateOutputIndex();
      this.toolOutputIndexes.set(index, outputIndex);
    }
    return outputIndex;
  }

  private event(type: string, fields: Record<string, unknown>): ResponseEvent {
    return {
      type,
      sequence_number: this.sequence++,
      ...fields,
    };
  }
}

export function responseToolCalls(toolCalls: OpenAIToolCall[]) {
  return cleanToolCalls(toolCalls);
}
