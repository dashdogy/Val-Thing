function firstJsonContainerEnd(value: string) {
  let index = 0;
  while (index < value.length && /\s/.test(value[index]!)) index += 1;
  const opening = value[index];
  if (opening !== "{" && opening !== "[") return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function isExactRepetition(value: string, period: number) {
  if (period <= 0 || period >= value.length || value.length % period !== 0) {
    return false;
  }
  for (let index = period; index < value.length; index += 1) {
    if (value[index] !== value[index % period]) return false;
  }
  return true;
}

/**
 * Collapses a Val/Open WebUI replay that concatenates the same complete JSON
 * function arguments more than once. The scan is linear and uses constant
 * extra memory, so a malformed large tool call cannot trigger quadratic work.
 */
export function collapseRepeatedJson(value: string) {
  const containerEnd = firstJsonContainerEnd(value);
  if (containerEnd === undefined || containerEnd >= value.length) return value;

  let maximumCandidateEnd = containerEnd;
  while (
    maximumCandidateEnd < value.length &&
    /\s/.test(value[maximumCandidateEnd]!)
  ) {
    maximumCandidateEnd += 1;
  }
  for (
    let candidateEnd = containerEnd;
    candidateEnd <= maximumCandidateEnd;
    candidateEnd += 1
  ) {
    if (!isExactRepetition(value, candidateEnd)) continue;
    const candidate = value.slice(0, candidateEnd);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      return value;
    }
  }
  return value;
}
