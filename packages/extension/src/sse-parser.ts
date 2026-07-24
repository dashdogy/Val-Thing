export type ParsedSseEvent = {
  eventType: string;
  data: string;
};

const DEFAULT_MAX_BUFFER_CHARACTERS = 16 * 1024 * 1024;

function boundary(value: string) {
  const match = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(value);
  return {
    index: match?.index ?? -1,
    length: match?.[0].length ?? 0,
  };
}

function fieldValue(line: string, colon: number) {
  if (colon < 0) return "";
  const value = line.slice(colon + 1);
  return value.startsWith(" ") ? value.slice(1) : value;
}

function parseBlock(block: string): ParsedSseEvent | undefined {
  let eventType = "message";
  const data: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = fieldValue(line, colon);
    if (field === "event") {
      eventType = value || "message";
    } else if (field === "data") {
      data.push(value);
    }
  }
  return data.length > 0 ? { eventType, data: data.join("\n") } : undefined;
}

export class SseParser {
  private buffer = "";

  constructor(
    private readonly maxBufferCharacters = DEFAULT_MAX_BUFFER_CHARACTERS,
  ) {}

  push(chunk: string) {
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(chunk = "") {
    this.buffer += chunk;
    return this.drain(true);
  }

  private drain(final: boolean) {
    const events: ParsedSseEvent[] = [];
    while (true) {
      const next = boundary(this.buffer);
      if (next.index < 0) break;
      const block = this.buffer.slice(0, next.index);
      this.buffer = this.buffer.slice(next.index + next.length);
      this.ensureWithinLimit(block);
      const event = parseBlock(block);
      if (event) events.push(event);
    }
    if (final && this.buffer) {
      this.ensureWithinLimit(this.buffer);
      const event = parseBlock(this.buffer);
      this.buffer = "";
      if (event) events.push(event);
    }
    if (this.buffer.length > this.maxBufferCharacters) {
      throw new Error("Val returned an oversized Responses stream event.");
    }
    return events;
  }

  private ensureWithinLimit(value: string) {
    if (value.length > this.maxBufferCharacters) {
      throw new Error("Val returned an oversized Responses stream event.");
    }
  }
}
