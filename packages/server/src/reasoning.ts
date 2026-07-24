type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => textParts(part)).join("");
  }
  if (!isRecord(value)) return "";

  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return textParts(value.content);
  if (Array.isArray(value.summary)) return textParts(value.summary);
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

function firstText(values: unknown[]) {
  for (const value of values) {
    const text = textParts(value);
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

/**
 * Extracts reasoning text from the OpenAI-compatible fields that Open WebUI
 * (and therefore Val) accepts from upstream providers. Only user-visible
 * reasoning/summary fields are considered; generic provider "analysis" fields
 * are deliberately excluded.
 */
export function reasoningTextFromRecord(
  record: JsonRecord | undefined,
): string {
  if (!record) return "";

  const direct = firstText([
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
    const eventText = firstText([
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
        firstText([part.text, part.content, part.summary, part.delta]);
      if (partText) return normalizeValReasoningText(partText);
    }
  }

  if (isRecord(record.item)) {
    const itemText = reasoningTextFromRecord(record.item);
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
      const itemText = reasoningTextFromRecord(item);
      if (itemText) return itemText;
      const fallback = firstText([item.summary, item.content, item.text]);
      if (fallback) return normalizeValReasoningText(fallback);
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

export function reasoningTextFromStatus(record: JsonRecord): string {
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
      firstText([
        record.content,
        record.text,
        record.summary,
        record.description,
      ]),
    );
  return isReasoningStatusPlaceholder(text) ? "" : text;
}

type OpeningTag = {
  index: number;
  length: number;
  closeTag: string;
};

function nextOpeningTag(content: string, from: number): OpeningTag | undefined {
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

  let next: OpeningTag | undefined;
  for (const pattern of patterns) {
    pattern.expression.lastIndex = from;
    const match = pattern.expression.exec(content);
    if (!match) continue;
    if (!next || match.index < next.index) {
      next = {
        index: match.index,
        length: match[0].length,
        closeTag: pattern.closeTag,
      };
    }
  }
  return next;
}

function stripSummaryElement(content: string) {
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
    stripSummaryElement(withoutPartialClosingTag(content, closeTag)),
  ).trim();
}

function mergeReasoningContainer(current: string, incoming: string) {
  if (!incoming || incoming === current) return current;
  if (!current || incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  return `${current}\n${incoming}`;
}

function withoutPartialTagSuffix(content: string, possibleTags: string[]) {
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

/**
 * Separates the reasoning containers emitted by Open WebUI-compatible
 * providers from final assistant text. It also handles a still-open container
 * so reasoning can be streamed before the closing tag arrives.
 */
export function splitValReasoningMarkup(rawContent: string) {
  let cursor = 0;
  let content = "";
  let reasoning = "";

  while (cursor < rawContent.length) {
    const opening = nextOpeningTag(rawContent, cursor);
    if (!opening) {
      content += withoutPartialTagSuffix(rawContent.slice(cursor), [
        "<details",
        "<think",
        "<thinking",
        "<reasoning",
      ]);
      break;
    }

    content += rawContent.slice(cursor, opening.index);
    const reasoningStart = opening.index + opening.length;
    const lowerContent = rawContent.toLowerCase();
    const closingIndex = lowerContent.indexOf(opening.closeTag, reasoningStart);
    const nestedOpening = nextOpeningTag(rawContent, reasoningStart);
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
          withoutPartialTagSuffix(rawContent.slice(reasoningStart), [
            opening.closeTag,
          ]),
          opening.closeTag,
        ),
      );
      cursor = rawContent.length;
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
