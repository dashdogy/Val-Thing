import assert from "node:assert/strict";
import test from "node:test";
import { collapseRepeatedJson } from "@val-bridge/protocol";

test("collapses exact repeated JSON tool arguments", () => {
  const value = '{"path":"src/{nested}.ts","options":[true,false]}';
  assert.equal(collapseRepeatedJson(value.repeat(3)), value);
  assert.equal(collapseRepeatedJson(`${value}\n${value}\n`), `${value}\n`);
});

test("preserves incomplete, different, and already valid arguments", () => {
  assert.equal(collapseRepeatedJson('{"value":'), '{"value":');
  assert.equal(
    collapseRepeatedJson('{"value":1}{"value":2}'),
    '{"value":1}{"value":2}',
  );
  assert.equal(collapseRepeatedJson('{"value":1}'), '{"value":1}');
});

test("handles large replayed arguments without a quadratic scan", () => {
  const value = JSON.stringify({ value: "x".repeat(1_000_000) });
  assert.equal(collapseRepeatedJson(value.repeat(2)), value);
});
