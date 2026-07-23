import type { RelayError } from "@val-bridge/protocol";

export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_connection_error"
  | "api_error";

export class OpenAIHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly type: OpenAIErrorType = "invalid_request_error",
    public readonly param: string | null = null,
  ) {
    super(message);
    this.name = "OpenAIHttpError";
  }
}

export function relayErrorToHttp(error: RelayError): OpenAIHttpError {
  const status = error.status ?? 502;
  if (status === 401) {
    return new OpenAIHttpError(
      status,
      error.code,
      error.message,
      "authentication_error",
    );
  }
  if (status === 404) {
    return new OpenAIHttpError(
      status,
      error.code,
      error.message,
      "not_found_error",
    );
  }
  if (status === 429) {
    return new OpenAIHttpError(
      status,
      error.code,
      error.message,
      "rate_limit_error",
    );
  }
  if (status === 502 || status === 503 || status === 504) {
    return new OpenAIHttpError(
      status,
      error.code,
      error.message,
      "api_connection_error",
    );
  }
  return new OpenAIHttpError(status, error.code, error.message);
}

export function openAIErrorBody(error: OpenAIHttpError) {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code,
    },
  };
}

export function asOpenAIHttpError(error: unknown): OpenAIHttpError {
  if (error instanceof OpenAIHttpError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new OpenAIHttpError(
      499,
      "request_cancelled",
      "The request was cancelled.",
      "api_error",
    );
  }
  return new OpenAIHttpError(
    500,
    "internal_error",
    error instanceof Error ? error.message : "An unexpected error occurred.",
    "api_error",
  );
}
