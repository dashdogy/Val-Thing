import type { RelayOpenAIHttpRequest } from "@val-bridge/protocol";
import { base64ToBytes } from "./openai-http-relay.js";
import { SseParser, type ParsedSseEvent } from "./sse-parser.js";
import { responseUsageDetails, type UsageOutcome } from "./usage-stats.js";

const MAX_CAPTURE_CHARACTERS = 16 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type OpenAIHttpGeneration = {
  model?: string;
  stream: boolean;
};

export type OpenAIHttpUsageResult = {
  usage?: JsonRecord;
  reasoningSummaryAvailable: boolean;
  outcome: UsageOutcome;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function requestJson(request: RelayOpenAIHttpRequest) {
  if (!request.body || request.body.encoding !== "base64") return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      base64ToBytes(request.body.data),
    );
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function openAIHttpGeneration(
  request: RelayOpenAIHttpRequest,
): OpenAIHttpGeneration | undefined {
  if (
    request.method !== "POST" ||
    (request.path !== "/v1/chat/completions" &&
      request.path !== "/v1/responses")
  ) {
    return undefined;
  }

  const body = requestJson(request);
  return {
    ...(typeof body?.model === "string" ? { model: body.model } : {}),
    stream: body?.stream === true,
  };
}

function outcomeFromValue(value: unknown): UsageOutcome | undefined {
  const event = record(value);
  const response = record(event?.response) ?? event;
  const type = typeof event?.type === "string" ? event.type : "";
  const status = typeof response?.status === "string" ? response.status : "";

  if (
    type === "error" ||
    type === "response.failed" ||
    type === "response.incomplete" ||
    status === "failed" ||
    status === "incomplete"
  ) {
    return "failed";
  }
  if (type === "response.cancelled" || status === "cancelled") {
    return "cancelled";
  }
  if (type === "response.completed" || status === "completed") {
    return "completed";
  }
  return undefined;
}

export class OpenAIHttpUsageCapture {
  private readonly decoder = new TextDecoder();
  private readonly parser?: SseParser;
  private jsonBuffer = "";
  private disabled = false;
  private usage?: JsonRecord;
  private reasoningSummaryAvailable = false;
  private terminalOutcome?: UsageOutcome;

  constructor(
    contentType: string | null,
    private readonly status: number,
    expectedStream = false,
  ) {
    if (
      expectedStream ||
      contentType?.toLowerCase().includes("text/event-stream")
    ) {
      this.parser = new SseParser(MAX_CAPTURE_CHARACTERS);
    }
  }

  push(chunk: Uint8Array) {
    if (this.disabled) return;
    try {
      const text = this.decoder.decode(chunk, { stream: true });
      if (this.parser) {
        for (const event of this.parser.push(text)) this.captureEvent(event);
      } else if (
        this.jsonBuffer.length + text.length <=
        MAX_CAPTURE_CHARACTERS
      ) {
        this.jsonBuffer += text;
      } else {
        this.disable();
      }
    } catch {
      this.disable();
    }
  }

  finish(): OpenAIHttpUsageResult {
    if (!this.disabled) {
      try {
        const tail = this.decoder.decode();
        if (this.parser) {
          for (const event of this.parser.finish(tail)) {
            this.captureEvent(event);
          }
        } else if (
          this.jsonBuffer.length + tail.length <=
          MAX_CAPTURE_CHARACTERS
        ) {
          this.jsonBuffer += tail;
          if (this.jsonBuffer.trim()) {
            this.captureValue(JSON.parse(this.jsonBuffer));
          }
        } else {
          this.disable();
        }
      } catch {
        this.disable();
      }
    }

    return {
      ...(this.usage ? { usage: this.usage } : {}),
      reasoningSummaryAvailable: this.reasoningSummaryAvailable,
      outcome:
        this.status >= 400 ? "failed" : (this.terminalOutcome ?? "completed"),
    };
  }

  private captureEvent(event: ParsedSseEvent) {
    if (event.data.trim() === "[DONE]") {
      this.terminalOutcome ??= "completed";
      return;
    }
    this.captureValue(JSON.parse(event.data));
  }

  private captureValue(value: unknown) {
    const details = responseUsageDetails(value);
    if (details.usage) this.usage = details.usage;
    this.reasoningSummaryAvailable =
      this.reasoningSummaryAvailable || details.reasoningSummaryAvailable;
    this.terminalOutcome = outcomeFromValue(value) ?? this.terminalOutcome;
  }

  private disable() {
    this.disabled = true;
    this.jsonBuffer = "";
  }
}
