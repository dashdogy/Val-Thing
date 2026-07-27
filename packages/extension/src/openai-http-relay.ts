const REQUEST_HEADER_NAMES = new Set([
  "accept",
  "content-type",
  "idempotency-key",
  "openai-beta",
  "openai-organization",
  "openai-project",
]);

const RESPONSE_HEADER_NAMES = new Set([
  "cache-control",
  "content-disposition",
  "content-type",
  "etag",
  "last-modified",
  "location",
  "retry-after",
  "retry-after-ms",
  "x-request-id",
  "x-should-retry",
]);

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_HEADER_LENGTH = 8 * 1024;
const VAL_OPENAI_ORIGIN = "https://val.rmit.edu.au";
const VAL_OPENAI_PATH_PREFIX = "/openai/v1/";

function safeHeader(name: string, value: string) {
  return (
    HEADER_NAME.test(name) &&
    value.length <= MAX_HEADER_LENGTH &&
    !value.includes("\r") &&
    !value.includes("\n") &&
    !value.includes("\0")
  );
}

function requestHeaderAllowed(name: string) {
  return REQUEST_HEADER_NAMES.has(name) || name.startsWith("x-stainless-");
}

function responseHeaderAllowed(name: string) {
  return (
    RESPONSE_HEADER_NAMES.has(name) ||
    name.startsWith("openai-") ||
    name.startsWith("x-ratelimit-") ||
    name.startsWith("x-val-")
  );
}

function canonicalQuery(query: string) {
  if (!query) return "";
  const entries: string[] = [];
  new URLSearchParams(query.slice(1)).forEach((value, name) => {
    entries.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  });
  return entries.join("&");
}

export function valOpenAIHttpUrl(path: string, query = "") {
  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw new Error("Invalid OpenAI relay URL.");
  }
  if (
    !path.startsWith("/v1/") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    path.includes("\0") ||
    decodedPath.includes("?") ||
    decodedPath.includes("#") ||
    decodedPath.includes("\\") ||
    decodedPath
      .split("/")
      .some((segment) => segment === "." || segment === "..") ||
    (query && !query.startsWith("?"))
  ) {
    throw new Error("Invalid OpenAI relay URL.");
  }

  // Re-encode every caller-controlled component before it reaches fetch. The
  // scheme, host, port, and /openai prefix are never supplied by the caller.
  const canonicalPath = path
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");
  const normalizedQuery = canonicalQuery(query);
  const url = new URL(
    `${VAL_OPENAI_ORIGIN}/openai${canonicalPath}${
      normalizedQuery ? `?${normalizedQuery}` : ""
    }`,
  );
  if (
    url.origin !== VAL_OPENAI_ORIGIN ||
    !url.pathname.startsWith(VAL_OPENAI_PATH_PREFIX)
  ) {
    throw new Error("Invalid OpenAI relay URL.");
  }
  return url;
}

export function openAIHttpRequestHeaders(
  headers: Record<string, string> | undefined,
  token: string,
) {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (
      requestHeaderAllowed(name) &&
      typeof value === "string" &&
      safeHeader(name, value)
    ) {
      result[name] = value;
    }
  }
  result.authorization = `Bearer ${token}`;
  return result;
}

export function openAIHttpResponseHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (responseHeaderAllowed(name) && safeHeader(name, value)) {
      result[name] = value;
    }
  });
  return result;
}

export function base64ToBytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}
