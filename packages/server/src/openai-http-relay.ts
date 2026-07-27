import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { RelayHttpMethod } from "@val-bridge/protocol";
import { OpenAIHttpError } from "./errors.js";

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

const HTTP_METHODS = new Set<RelayHttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
]);

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_RELAY_HEADER_LENGTH = 8 * 1024;
const MAX_RELAY_CHUNK_BASE64_LENGTH = 2 * 1024 * 1024;

function invalidProxyRequest(
  code: string,
  message: string,
  status = 400,
): never {
  throw new OpenAIHttpError(status, code, message, "invalid_request_error");
}

function safeHeaderValue(value: string) {
  return (
    value.length <= MAX_RELAY_HEADER_LENGTH &&
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

export function relayHttpMethod(method: string | undefined): RelayHttpMethod {
  const normalized = method?.toUpperCase() as RelayHttpMethod | undefined;
  if (!normalized || !HTTP_METHODS.has(normalized)) {
    invalidProxyRequest(
      "unsupported_http_method",
      `The HTTP method ${method ?? "(missing)"} is not supported by the Val bridge.`,
      405,
    );
  }
  return normalized;
}

export function validateOpenAIProxyPath(pathname: string) {
  if (
    !pathname.startsWith("/v1/") ||
    pathname.includes("\\") ||
    pathname.includes("\0")
  ) {
    invalidProxyRequest(
      "invalid_proxy_path",
      "Only canonical OpenAI /v1/* paths can be relayed to Val.",
    );
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    invalidProxyRequest(
      "invalid_proxy_path",
      "The OpenAI endpoint path contains invalid URL encoding.",
    );
  }
  if (
    decoded.includes("\\") ||
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    invalidProxyRequest(
      "invalid_proxy_path",
      "The OpenAI endpoint path must not contain traversal segments.",
    );
  }
  return pathname;
}

export function requestHeadersForRelay(headers: IncomingHttpHeaders) {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!requestHeaderAllowed(name) || rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (!HEADER_NAME.test(name) || !safeHeaderValue(value)) {
      invalidProxyRequest(
        "invalid_proxy_header",
        `The request header "${rawName}" cannot be relayed to Val.`,
      );
    }
    result[name] = value;
  }
  return result;
}

export function responseHeadersForClient(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!responseHeaderAllowed(name)) continue;
    if (
      typeof value !== "string" ||
      !HEADER_NAME.test(name) ||
      !safeHeaderValue(value)
    ) {
      throw new OpenAIHttpError(
        502,
        "invalid_upstream_header",
        "Val returned an invalid HTTP response header.",
        "api_connection_error",
      );
    }
    result[name] = value;
  }
  return result;
}

export async function readRawBody(
  request: IncomingMessage,
  limitBytes: number,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > limitBytes) {
      throw new OpenAIHttpError(
        413,
        "request_too_large",
        `Request bodies are limited to ${limitBytes} bytes.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBuffer(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8") || "{}");
  } catch {
    throw new OpenAIHttpError(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
}

export function decodeRelayChunk(data: string) {
  if (
    typeof data !== "string" ||
    data.length > MAX_RELAY_CHUNK_BASE64_LENGTH ||
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  ) {
    throw new OpenAIHttpError(
      502,
      "invalid_upstream_body",
      "The extension returned an invalid HTTP response chunk.",
      "api_connection_error",
    );
  }
  return Buffer.from(data, "base64");
}
