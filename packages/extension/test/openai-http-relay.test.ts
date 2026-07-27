import assert from "node:assert/strict";
import test from "node:test";
import {
  base64ToBytes,
  bytesToBase64,
  openAIHttpRequestHeaders,
  openAIHttpResponseHeaders,
  valOpenAIHttpUrl,
} from "../src/openai-http-relay.js";

test("builds only same-origin Val OpenAI relay URLs", () => {
  const url = valOpenAIHttpUrl(
    "/v1/responses/resp_123",
    "?include=reasoning.encrypted_content",
  );
  assert.equal(url.origin, "https://val.rmit.edu.au");
  assert.equal(url.pathname, "/openai/v1/responses/resp_123");
  assert.equal(
    url.toString(),
    "https://val.rmit.edu.au/openai/v1/responses/resp_123?include=reasoning.encrypted_content",
  );
  assert.throws(
    () => valOpenAIHttpUrl("https://example.com/v1/models"),
    /Invalid/,
  );
  assert.throws(() => valOpenAIHttpUrl("/v1/files/%2e%2e/models"), /Invalid/);
  assert.throws(() => valOpenAIHttpUrl("/v1/models?host=evil"), /Invalid/);
  assert.throws(() => valOpenAIHttpUrl("/v1/models#evil"), /Invalid/);
});

test("canonicalizes encoded path and query components", () => {
  assert.equal(
    valOpenAIHttpUrl(
      "/v1/responses/space%20id",
      "?cursor=a%20b&include=reasoning.encrypted_content",
    ).toString(),
    "https://val.rmit.edu.au/openai/v1/responses/space%20id?cursor=a%20b&include=reasoning.encrypted_content",
  );
});

test("replaces local authentication and filters relay headers", () => {
  assert.deepEqual(
    openAIHttpRequestHeaders(
      {
        authorization: "Bearer local-secret",
        cookie: "session=secret",
        "content-type": "application/json",
        "openai-beta": "responses_multi_agent=v1",
        "openai-api-key": "alternate-secret",
        "x-stainless-helper-method": "responses.parse",
      },
      "val-session-token",
    ),
    {
      authorization: "Bearer val-session-token",
      "content-type": "application/json",
      "openai-beta": "responses_multi_agent=v1",
      "x-stainless-helper-method": "responses.parse",
    },
  );

  assert.deepEqual(
    openAIHttpResponseHeaders(
      new Headers({
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
        "retry-after-ms": "250",
        "set-cookie": "session=secret",
        "x-request-id": "req_val",
        "x-should-retry": "false",
      }),
    ),
    {
      "content-type": "application/octet-stream",
      "retry-after-ms": "250",
      "x-request-id": "req_val",
      "x-should-retry": "false",
    },
  );
});

test("round-trips binary request and response chunks", () => {
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});
