import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRelayChunk,
  parseJsonBuffer,
  relayHttpMethod,
  requestHeadersForRelay,
  responseHeadersForClient,
  validateOpenAIProxyPath,
} from "../src/openai-http-relay.js";

test("validates canonical OpenAI relay methods and paths", () => {
  assert.equal(relayHttpMethod("post"), "POST");
  assert.equal(
    validateOpenAIProxyPath("/v1/responses/resp_123/input_items"),
    "/v1/responses/resp_123/input_items",
  );
  assert.throws(() => relayHttpMethod("CONNECT"), /not supported/);
  assert.throws(() => validateOpenAIProxyPath("/api/models"), /canonical/);
  assert.throws(
    () => validateOpenAIProxyPath("/v1/files/%2e%2e/models"),
    /traversal/,
  );
});

test("relays only SDK headers that cannot carry browser credentials", () => {
  assert.deepEqual(
    requestHeadersForRelay({
      accept: "application/json",
      authorization: "Bearer local-secret",
      cookie: "session=secret",
      "content-type": "multipart/form-data; boundary=test",
      "idempotency-key": "retry-safe",
      "openai-beta": "responses_multi_agent=v1",
      "openai-api-key": "alternate-secret",
      "x-stainless-helper-method": "responses.stream",
      "x-forwarded-for": "203.0.113.1",
    }),
    {
      accept: "application/json",
      "content-type": "multipart/form-data; boundary=test",
      "idempotency-key": "retry-safe",
      "openai-beta": "responses_multi_agent=v1",
      "x-stainless-helper-method": "responses.stream",
    },
  );

  assert.deepEqual(
    responseHeadersForClient({
      "content-type": "application/json",
      "content-encoding": "gzip",
      "retry-after-ms": "250",
      "set-cookie": "session=secret",
      "x-request-id": "req_val",
      "x-ratelimit-remaining-requests": "12",
      "x-should-retry": "false",
    }),
    {
      "content-type": "application/json",
      "retry-after-ms": "250",
      "x-request-id": "req_val",
      "x-ratelimit-remaining-requests": "12",
      "x-should-retry": "false",
    },
  );
});

test("parses JSON bodies and validates binary relay chunks", () => {
  assert.deepEqual(parseJsonBuffer(Buffer.from('{"ok":true}')), { ok: true });
  assert.throws(() => parseJsonBuffer(Buffer.from("{")), /valid JSON/);
  assert.equal(
    decodeRelayChunk(
      Buffer.from("binary\u0000data").toString("base64"),
    ).toString("utf8"),
    "binary\u0000data",
  );
  assert.throws(() => decodeRelayChunk("not-base64"), /invalid HTTP response/);
});
