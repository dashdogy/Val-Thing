import assert from "node:assert/strict";
import test from "node:test";
import { SseParser } from "../src/sse-parser.js";

test("parses fragmented LF and CRLF response events", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: response.cre"), []);
  assert.deepEqual(
    parser.push('ated\r\ndata: {"type":"response.created"}\r\n\r\n'),
    [
      {
        eventType: "response.created",
        data: '{"type":"response.created"}',
      },
    ],
  );
  assert.deepEqual(parser.push('data: {"type":"response.completed"}\n\n'), [
    {
      eventType: "message",
      data: '{"type":"response.completed"}',
    },
  ]);
});

test("accepts mixed SSE line endings", () => {
  const parser = new SseParser();
  assert.deepEqual(
    parser.push(
      'event: response.created\r\ndata: {"type":"response.created"}\n\r\n',
    ),
    [
      {
        eventType: "response.created",
        data: '{"type":"response.created"}',
      },
    ],
  );
});

test("joins multiline data and flushes a final unterminated event", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.finish("event: message\ndata: first\ndata: second"), [
    { eventType: "message", data: "first\nsecond" },
  ]);
});

test("ignores comments and rejects an oversized unfinished event", () => {
  const parser = new SseParser(12);
  assert.deepEqual(parser.push(": heartbeat\n\n"), []);
  assert.throws(
    () => parser.push("data: 123456789"),
    /oversized Responses stream event/,
  );
  assert.throws(
    () => new SseParser(12).push("data: 123456789\n\n"),
    /oversized Responses stream event/,
  );
});
