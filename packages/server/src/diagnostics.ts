import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ReasoningDisclosure,
  UsageTokenCounts,
} from "./reasoning-state.js";

const MAX_LOG_BYTES = 1024 * 1024;

type GenerationEndpoint = "chat.completions" | "responses";
type GenerationOutcome = "completed" | "failed" | "cancelled";

export type GenerationDiagnostic = {
  endpoint: GenerationEndpoint;
  requestId: string;
  model: string;
  stream: boolean;
  outcome: GenerationOutcome;
  durationMs: number;
  usage: UsageTokenCounts;
  reasoning: ReasoningDisclosure;
  toolCalls: number;
  finishReason?: string;
  errorCode?: string;
};

function safeIdentifier(value: string, fallback: string) {
  const trimmed = value.trim().slice(0, 160);
  return /^[A-Za-z0-9._:/-]+$/.test(trimmed) ? trimmed : fallback;
}

function safeReasoningValue(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(normalized) ? normalized : "other";
}

export class DiagnosticsLog {
  readonly path: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(configDirectory: string) {
    this.path = join(configDirectory, "diagnostics.jsonl");
  }

  recordGeneration(event: GenerationDiagnostic) {
    const entry = {
      timestamp: new Date().toISOString(),
      event: "generation",
      endpoint: event.endpoint,
      request_id: safeIdentifier(event.requestId, "redacted"),
      model: safeIdentifier(event.model, "invalid-model-id"),
      stream: event.stream,
      outcome: event.outcome,
      duration_ms: Math.max(0, Math.floor(event.durationMs)),
      input_tokens: event.usage.inputTokens,
      output_tokens: event.usage.outputTokens,
      total_tokens: event.usage.totalTokens,
      reasoning_status: event.reasoning.status,
      reasoning_tokens: event.reasoning.reasoning_tokens,
      reasoning_tokens_reported: event.reasoning.tokens_reported,
      reasoning_summary_available: event.reasoning.summary_available,
      ...(event.reasoning.requested_effort
        ? {
            requested_reasoning_effort: safeReasoningValue(
              event.reasoning.requested_effort,
            ),
          }
        : {}),
      ...(event.reasoning.requested_summary
        ? {
            requested_reasoning_summary: safeReasoningValue(
              event.reasoning.requested_summary,
            ),
          }
        : {}),
      tool_calls: Math.max(0, Math.floor(event.toolCalls)),
      ...(event.finishReason
        ? {
            finish_reason: safeIdentifier(event.finishReason, "unrecognized"),
          }
        : {}),
      ...(event.errorCode
        ? { error_code: safeIdentifier(event.errorCode, "unknown_error") }
        : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => this.append(line));
  }

  async close() {
    await this.pending.catch(() => undefined);
  }

  private async append(line: string) {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const details = await stat(this.path);
      if (details.size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        const previous = `${this.path}.1`;
        await rm(previous, { force: true });
        await rename(this.path, previous);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
  }
}
