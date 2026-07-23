import assert from "node:assert/strict";
import test from "node:test";
import type {
  OpenAIMessage,
  RelayCompletionRequest,
} from "@val-bridge/protocol";
import {
  buildValHistory,
  completionPayload,
  findValNativeToolTraces,
  isBridgeClientToolEvent,
  messageText,
  parseClientToolCalls,
  parseClientToolExecution,
  reasoningTextFromRecord,
  reasoningTextFromStatus,
  resolveClientToolResponse,
  splitValReasoningMarkup,
  storedMessagesToOpenAI,
} from "../src/relay-utils.js";

test("builds a linear Val history with a unique unfinished assistant node", () => {
  const messages: OpenAIMessage[] = [
    { role: "system", content: "Be concise." },
    {
      role: "user",
      content: [
        { type: "text", text: "What is shown?" },
        { type: "image_url", image_url: "https://example.test/image.png" },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "A diagram." },
  ];

  const built = buildValHistory(messages, "val-model", 1_700_000_000);
  assert.equal(built.messages.length, messages.length + 1);
  assert.equal(built.history.currentId, built.assistantMessageId);
  assert.equal(built.history.messages[built.assistantMessageId]?.done, false);
  assert.equal(
    built.history.messages[built.assistantMessageId]?.parentId,
    built.messages.at(-2)?.id,
  );
  assert.equal(built.messages.at(-2)?.childrenIds[0], built.assistantMessageId);
  assert.equal(messageText(messages[1]!), "What is shown?\n[image]");
});

test("reconstructs stored messages but ignores unfinished assistant placeholders", () => {
  const messages = storedMessagesToOpenAI([
    { role: "user", content: "first" },
    { role: "assistant", content: "", done: false },
    {
      role: "assistant",
      content: null,
      done: true,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "result" },
  ]);

  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(messages[1]?.tool_calls?.[0]?.id, "call_1");
  assert.equal(messages[2]?.tool_call_id, "call_1");
});

test("creates a streamed Val completion payload with correlation identifiers", () => {
  const request: RelayCompletionRequest = {
    kind: "completion",
    model: "val-model",
    messages: [{ role: "user", content: "hello" }],
    parameters: { temperature: 0.2, stop: ["END"] },
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object" },
          strict: true,
        },
      },
    ],
    toolChoice: {
      type: "function",
      function: { name: "lookup" },
    },
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: { type: "object" },
      },
    },
    persistence: { mode: "temporary" },
  };

  const payload = completionPayload(
    request,
    {
      id: "val-model",
      name: "Val model",
      info: {
        params: { function_calling: "indirect" },
        meta: {
          capabilities: { builtin_tools: true, web_search: true, vision: true },
          knowledge: ["knowledge-1"],
          toolIds: ["tool-1"],
          filterIds: ["filter-1"],
          actionIds: ["action-1"],
        },
      },
    },
    "socket-session",
    "local",
    "assistant-message",
    request.messages,
  );

  assert.equal(payload.stream, true);
  assert.equal(payload.session_id, "socket-session");
  assert.equal(payload.chat_id, "local");
  assert.equal(payload.id, "assistant-message");
  assert.deepEqual(payload.params, {
    temperature: 0.2,
    stop: ["END"],
    function_calling: "indirect",
  });
  assert.equal(
    (payload.response_format as { type?: string }).type,
    "json_schema",
  );
  assert.deepEqual(payload.tool_ids, []);
  assert.equal("tools" in payload, false);
  assert.equal("tool_choice" in payload, false);
  assert.deepEqual(payload.tool_servers, [
    {
      id: "val-openai-local-bridge",
      name: "OpenAI API client tools",
      type: "openapi",
      auth_type: "none",
      url: "http://127.0.0.1/val-openai-local-bridge/client-tools",
      specs: [
        {
          name: "lookup",
          parameters: { type: "object" },
        },
      ],
    },
  ]);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  const submittedModel = payload.model_item as {
    info?: {
      params?: Record<string, unknown>;
      meta?: {
        capabilities?: Record<string, unknown>;
        builtinTools?: Record<string, unknown>;
        knowledge?: unknown[];
        toolIds?: unknown[];
        filterIds?: unknown[];
        actionIds?: unknown[];
      };
    };
  };
  assert.equal(submittedModel.info?.params?.function_calling, "indirect");
  assert.equal(submittedModel.info?.meta?.capabilities?.builtin_tools, false);
  assert.equal(submittedModel.info?.meta?.capabilities?.web_search, false);
  assert.equal(submittedModel.info?.meta?.capabilities?.vision, true);
  assert.equal(submittedModel.info?.meta?.builtinTools?.chats, false);
  assert.equal(submittedModel.info?.meta?.builtinTools?.knowledge, false);
  assert.equal(submittedModel.info?.meta?.builtinTools?.time, false);
  assert.deepEqual(submittedModel.info?.meta?.knowledge, []);
  assert.deepEqual(submittedModel.info?.meta?.toolIds, []);
  assert.deepEqual(submittedModel.info?.meta?.filterIds, []);
  assert.deepEqual(submittedModel.info?.meta?.actionIds, []);
  assert.match(
    String(payload.messages[0]?.content),
    /client-side function protocol/i,
  );
  assert.match(
    String(payload.messages[0]?.content),
    /never call Val, RMIT, knowledge-base/i,
  );
  assert.match(
    String(payload.messages[0]?.content),
    /function must be "lookup"/i,
  );
  assert.match(
    String(payload.messages[0]?.content),
    /appear in the native function list/i,
  );
});

test("parses Val direct client-tool execution events and rejects unknown tools", () => {
  const bridgeServer = {
    id: "val-openai-local-bridge",
    url: "http://127.0.0.1/val-openai-local-bridge/client-tools",
  };
  assert.equal(
    isBridgeClientToolEvent(
      {
        name: "glob",
        parameters: { pattern: "**/README*" },
        server: bridgeServer,
      },
      ["glob", "read"],
    ),
    true,
  );
  assert.equal(
    isBridgeClientToolEvent(
      {
        name: "view_chat",
        server: bridgeServer,
      },
      ["glob", "read"],
    ),
    false,
  );
  assert.equal(
    isBridgeClientToolEvent(
      {
        name: "glob",
        server: {
          id: "val-internal-tools",
          url: "https://val.rmit.edu.au/internal",
        },
      },
      ["glob", "read"],
    ),
    false,
  );

  assert.deepEqual(
    parseClientToolExecution(
      {
        name: "glob",
        params: { pattern: "**/README*" },
        server: bridgeServer,
      },
      ["glob", "read"],
    ),
    {
      name: "glob",
      arguments: '{"pattern":"**/README*"}',
    },
  );

  assert.throws(
    () =>
      parseClientToolExecution(
        { name: "view_chat", params: { chat_id: "x" } },
        ["glob"],
      ),
    /unavailable client function "view_chat"/i,
  );
});

test("detects Val-rendered native tool traces without treating the UI as a client call", () => {
  const content = [
    "I will inspect the workspace.",
    '<details type="tool_calls" done="true" internal_id="builtin:view_chat" name="view_chat" arguments="&quot;{\\&quot;chat_id\\&quot;:\\&quot;x\\&quot;}&quot;">',
    "<summary>Tool Executed</summary>",
    "</details>",
  ].join("\n");

  assert.deepEqual(findValNativeToolTraces(content), [
    {
      name: "view_chat",
      internalId: "builtin:view_chat",
    },
  ]);
  assert.deepEqual(parseClientToolCalls(content, ["glob"]), {
    content,
    toolCalls: [],
  });
});

test("parses client-side function envelopes and rejects unavailable names", () => {
  const parsed = parseClientToolCalls(
    [
      "```json",
      '<val_openai_tool_calls>{"calls":[{"name":"glob","arguments":{"pattern":"**/*"}},{"name":"glob","arguments":{"pattern":"**/*"}}]}</val_openai_tool_calls>',
      "```",
    ].join("\n"),
    ["glob", "read"],
  );

  assert.equal(parsed.content, "");
  assert.deepEqual(parsed.toolCalls, [
    { name: "glob", arguments: '{"pattern":"**/*"}' },
  ]);

  assert.throws(
    () =>
      parseClientToolCalls(
        '<val_openai_tool_calls>{"calls":[{"name":"search_chats","arguments":{}}]}</val_openai_tool_calls>',
        ["glob"],
      ),
    /unavailable client function "search_chats"/i,
  );
});

test("leaves ordinary assistant text unchanged when no function envelope exists", () => {
  assert.deepEqual(parseClientToolCalls("A direct answer.", ["glob"]), {
    content: "A direct answer.",
    toolCalls: [],
  });
});

test("keeps prose outside a function envelope and treats mixed auto output as final", () => {
  const mixed = [
    '<val_openai_tool_calls>{"calls":[{"name":"glob","arguments":{"pattern":"**/*"}}]}</val_openai_tool_calls>',
    "",
    "## Overview",
    "",
    "The model has enough information to provide the final answer.",
  ].join("\n");

  assert.deepEqual(parseClientToolCalls(mixed, ["glob"]), {
    content:
      "## Overview\n\nThe model has enough information to provide the final answer.",
    toolCalls: [{ name: "glob", arguments: '{"pattern":"**/*"}' }],
  });
  assert.deepEqual(resolveClientToolResponse(mixed, ["glob"], "auto"), {
    content:
      "## Overview\n\nThe model has enough information to provide the final answer.",
    toolCalls: [],
  });
});

test("required tool choice ignores mixed prose and still returns the requested call", () => {
  const mixed =
    '<val_openai_tool_calls>{"calls":[{"name":"glob","arguments":{"pattern":"src/**"}}]}</val_openai_tool_calls>\nDo not use this prose.';

  assert.deepEqual(resolveClientToolResponse(mixed, ["glob"], "required"), {
    content: "",
    toolCalls: [{ name: "glob", arguments: '{"pattern":"src/**"}' }],
  });
});

test("extracts Val reasoning aliases, summary items, and reasoning statuses", () => {
  assert.equal(
    reasoningTextFromRecord({ reasoning_content: "native summary" }),
    "native summary",
  );
  assert.equal(
    reasoningTextFromRecord({
      type: "reasoning",
      summary: [
        { type: "summary_text", text: "part one" },
        { type: "summary_text", text: " and two" },
      ],
    }),
    "part one and two",
  );
  assert.equal(
    reasoningTextFromStatus({
      type: "status",
      action: "reasoning",
      description: "Checking the plan",
    }),
    "Checking the plan",
  );
  assert.equal(
    reasoningTextFromStatus({
      type: "status",
      action: "web_search",
      description: "Searching",
    }),
    "",
  );
  assert.equal(
    reasoningTextFromRecord({
      reasoning_content: "> growing snapshot</think\n",
    }),
    "growing snapshot",
  );
  assert.equal(reasoningTextFromRecord({ reasoning_content: "</think" }), "");
});

test("separates Val thinking containers from client tool envelopes", () => {
  const separated = splitValReasoningMarkup(
    [
      '<details type="reasoning" done="true" duration="2">',
      "<summary>Thought for 2 seconds</summary>",
      "I should inspect the workspace.",
      "</details>",
      '<val_openai_tool_calls>{"calls":[{"name":"glob","arguments":{"pattern":"**/*"}}]}</val_openai_tool_calls>',
    ].join("\n"),
  );

  assert.equal(separated.reasoning, "I should inspect the workspace.");
  assert.match(separated.content, /<val_openai_tool_calls>/);
  assert.deepEqual(
    resolveClientToolResponse(separated.content, ["glob"], "auto"),
    {
      content: "",
      toolCalls: [{ name: "glob", arguments: '{"pattern":"**/*"}' }],
    },
  );
});

test("collapses repeated Open WebUI reasoning snapshots", () => {
  const separated = splitValReasoningMarkup(
    [
      "<think>\n> ABC\n</think>",
      "<think>\n> ABCDEF\n</think>",
      "<think>\n> ABCDEF</\n",
      "<think>\n> ABCDEF</think\n",
      "<think>\n> ABCDEF\n</think>",
      "FINAL",
    ].join(""),
  );

  assert.equal(separated.reasoning, "ABCDEF");
  assert.equal(separated.content, "FINAL");
});
