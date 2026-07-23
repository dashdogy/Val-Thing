import assert from "node:assert/strict";
import test from "node:test";
import { ChatAccumulator } from "../src/chat-accumulator.js";
import { ResponsesAdapter } from "../src/responses-adapter.js";
import { parseResponse } from "../src/openai-schema.js";

test("normalizes deltas, prefix replacements, usage, and completion shape", () => {
  const accumulator = new ChatAccumulator("val-model", {
    id: "chatcmpl_test",
    created: 123,
  });

  const first = accumulator.consume({ kind: "delta", content: "hel" });
  const replacement = accumulator.consume({
    kind: "replace",
    content: "hello",
  });
  accumulator.consume({
    kind: "usage",
    usage: {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    },
  });

  assert.equal(first[0]?.choices[0]?.delta.role, "assistant");
  assert.equal(first[0]?.choices[0]?.delta.content, "hel");
  assert.equal(replacement[0]?.choices[0]?.delta.content, "lo");
  assert.equal(accumulator.content, "hello");
  assert.deepEqual(accumulator.completion().usage, {
    prompt_tokens: 4,
    completion_tokens: 2,
    total_tokens: 6,
  });
});

test("separates native Val reasoning fields from final answer text", () => {
  const accumulator = new ChatAccumulator("val-model");
  const first = accumulator.consume({
    kind: "openai",
    data: {
      choices: [
        {
          delta: {
            reasoning_content: "Checking the",
          },
          finish_reason: null,
        },
      ],
    },
  });
  const second = accumulator.consume({
    kind: "openai",
    data: {
      choices: [
        {
          delta: {
            reasoning: " arithmetic.",
            content: "42",
          },
          finish_reason: "stop",
        },
      ],
    },
  });

  assert.equal(first[0]?.choices[0]?.delta.reasoning_content, "Checking the");
  assert.equal(second[0]?.choices[0]?.delta.reasoning_content, " arithmetic.");
  assert.equal(second[0]?.choices[0]?.delta.content, "42");
  assert.equal(accumulator.reasoning, "Checking the arithmetic.");
  assert.equal(accumulator.content, "42");
  assert.equal(
    accumulator.completion().choices[0]?.message.reasoning_content,
    "Checking the arithmetic.",
  );
});

test("normalizes Val reasoning snapshots and streamed closing-tag fragments", () => {
  const accumulator = new ChatAccumulator("val-model");
  const chunks = [
    "> ABC\n",
    "> ABCDEF\n",
    "> ABCDEF</\n",
    "</think",
    "> ABCDEF\n",
    "> ABCDEF\n",
  ].flatMap((reasoning_content) =>
    accumulator.consume({
      kind: "openai",
      data: {
        choices: [
          {
            delta: { reasoning_content },
            finish_reason: null,
          },
        ],
      },
    }),
  );

  assert.equal(accumulator.reasoning, "ABCDEF");
  assert.equal(
    chunks
      .map((chunk) => chunk.choices[0]?.delta.reasoning_content ?? "")
      .join(""),
    "ABCDEF",
  );
});

test("streams fragmented Val reasoning markup without leaking tags into content", () => {
  const accumulator = new ChatAccumulator("val-model");
  const chunks = [
    "<thi",
    "nk>Check",
    " the result</th",
    "ink>\nFinal answer",
  ].flatMap((content) => accumulator.consume({ kind: "delta", content }));

  assert.equal(accumulator.reasoning, "Check the result");
  assert.equal(accumulator.content, "\nFinal answer");
  assert.equal(
    chunks
      .map((chunk) => chunk.choices[0]?.delta.reasoning_content ?? "")
      .join(""),
    "Check the result",
  );
  assert.equal(
    chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join(""),
    "\nFinal answer",
  );
  assert.ok(
    chunks.every(
      (chunk) => !JSON.stringify(chunk).toLowerCase().includes("<think"),
    ),
  );
});

test("collapses Open WebUI reasoning snapshots and partial closing tags", () => {
  const accumulator = new ChatAccumulator("val-model");
  const chunks = [
    "<think>\n> ABC\n</think>",
    "<think>\n> ABCDEF\n</think>",
    "<think>\n> ABCDEF</\n",
    "<think>\n> ABCDEF</think\n",
    "<think>\n> ABCDEF\n</think>\nFINAL",
  ].flatMap((content) => accumulator.consume({ kind: "delta", content }));

  assert.equal(accumulator.reasoning, "ABCDEF");
  assert.equal(accumulator.content, "\nFINAL");
  assert.equal(
    chunks
      .map((chunk) => chunk.choices[0]?.delta.reasoning_content ?? "")
      .join(""),
    "ABCDEF",
  );
  assert.equal(
    chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join(""),
    "\nFINAL",
  );
});

test("accepts explicit reasoning status records but ignores ordinary statuses", () => {
  const accumulator = new ChatAccumulator("val-model");
  assert.deepEqual(
    accumulator.consume({
      kind: "status",
      data: {
        type: "status",
        action: "knowledge_search",
        description: "Searching notes",
      },
    }),
    [],
  );
  const chunks = accumulator.consume({
    kind: "status",
    data: {
      type: "reasoning",
      description: "Comparing both approaches",
      done: false,
    },
  });
  assert.equal(
    chunks[0]?.choices[0]?.delta.reasoning_content,
    "Comparing both approaches",
  );
});

test("assembles split tool-call deltas and preserves finish reasons", () => {
  const accumulator = new ChatAccumulator("val-model");
  accumulator.consume({
    kind: "openai",
    data: {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_weather",
                type: "function",
                function: { name: "get_", arguments: '{"city":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
  });
  accumulator.consume({
    kind: "openai",
    data: {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { name: "weather", arguments: '"Melbourne"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 5,
        total_tokens: 13,
      },
    },
  });

  const completion = accumulator.completion();
  assert.deepEqual(completion.choices[0]?.message.tool_calls, [
    {
      id: "call_weather",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"city":"Melbourne"}',
      },
    },
  ]);
  assert.equal(completion.choices[0]?.finish_reason, "tool_calls");
});

test("normalizes legacy function_call deltas into modern tool_calls", () => {
  const accumulator = new ChatAccumulator("val-model");
  const first = accumulator.consume({
    kind: "openai",
    data: {
      choices: [
        {
          delta: {
            function_call: {
              name: "bridge_echo",
              arguments: '{"value":',
            },
          },
          finish_reason: null,
        },
      ],
    },
  });
  accumulator.consume({
    kind: "openai",
    data: {
      choices: [
        {
          delta: {
            function_call: {
              arguments: '"ok"}',
            },
          },
          finish_reason: "function_call",
        },
      ],
    },
  });

  const streamedCall = first[0]?.choices[0]?.delta.tool_calls as
    Array<{ id?: string; type?: string }> | undefined;
  assert.match(streamedCall?.[0]?.id ?? "", /^call_/);
  assert.equal(streamedCall?.[0]?.type, "function");
  assert.equal(accumulator.finishReason, "tool_calls");
  assert.equal(accumulator.toolCalls[0]?.function.name, "bridge_echo");
  assert.equal(accumulator.toolCalls[0]?.function.arguments, '{"value":"ok"}');
});

test("reports tool_calls when an upstream tool response incorrectly finishes with stop", () => {
  const accumulator = new ChatAccumulator("val-model");
  accumulator.consume({
    kind: "openai",
    data: {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          finish_reason: "stop",
        },
      ],
    },
  });
  assert.equal(accumulator.finishReason, "tool_calls");
});

test("does not concatenate repeated full tool-call snapshots", () => {
  const accumulator = new ChatAccumulator("val-model");
  const event = {
    kind: "openai" as const,
    data: {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "bridge_echo",
                  arguments: '{"value":"ok"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
  };
  accumulator.consume(event);
  const repeated = accumulator.consume(event);

  assert.equal(accumulator.toolCalls[0]?.function.name, "bridge_echo");
  assert.equal(accumulator.toolCalls[0]?.function.arguments, '{"value":"ok"}');
  assert.equal(repeated.length, 0);
});

test("ignores a tool-argument stream replayed from its beginning", () => {
  const accumulator = new ChatAccumulator("val-model");
  const event = (argumentsValue: string) => ({
    kind: "openai" as const,
    data: {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "bridge_echo",
                  arguments: argumentsValue,
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
  });
  accumulator.consume(event('{"value":"ok"}'));
  accumulator.consume(event('{"value":'));
  accumulator.consume(event('"ok"}'));

  assert.equal(accumulator.toolCalls[0]?.function.arguments, '{"value":"ok"}');
});

test("keeps distinct tool calls separate when Val reuses or omits stream indexes", () => {
  const accumulator = new ChatAccumulator("val-model");
  for (const toolCall of [
    {
      id: "call_knowledge",
      name: "query_knowledge_files",
      arguments: '{"query":"repo"}',
    },
    {
      id: "call_search",
      name: "search_chats",
      arguments: '{"query":"repo"}',
    },
  ]) {
    accumulator.consume({
      kind: "openai",
      data: {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: toolCall.id,
                  type: "function",
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    });
  }

  assert.deepEqual(
    accumulator.toolCalls.map((toolCall) => toolCall.function.name),
    ["query_knowledge_files", "search_chats"],
  );
});

test("produces Responses lifecycle, text, tool, and completion events", () => {
  const request = parseResponse({
    model: "val-model",
    input: "Use a tool.",
    stream: true,
  });
  const accumulator = new ChatAccumulator("val-model", { created: 456 });
  const adapter = new ResponsesAdapter(request, accumulator, {
    id: "resp_test",
  });

  const initial = adapter.initialEvents();
  const textChunks = accumulator.consume({
    kind: "delta",
    content: "Checking",
  });
  const textEvents = textChunks.flatMap((chunk) =>
    adapter.eventsFromChunk(chunk),
  );
  const toolChunks = accumulator.consume({
    kind: "openai",
    data: {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  });
  const toolEvents = toolChunks.flatMap((chunk) =>
    adapter.eventsFromChunk(chunk),
  );
  const final = adapter.finalEvents();
  const eventTypes = [...initial, ...textEvents, ...toolEvents, ...final].map(
    (event) => event.type,
  );

  assert.deepEqual(
    initial.map((event) => event.type),
    ["response.created", "response.in_progress"],
  );
  assert.ok(eventTypes.includes("response.output_text.delta"));
  assert.ok(eventTypes.includes("response.function_call_arguments.delta"));
  assert.equal(eventTypes.at(-1), "response.completed");
  assert.deepEqual(
    [...initial, ...textEvents, ...toolEvents, ...final].map(
      (event) => event.sequence_number,
    ),
    Array.from({ length: eventTypes.length }, (_, index) => index),
  );
});

test("maps Val thinking text to standard Responses reasoning summary events", () => {
  const request = parseResponse({
    model: "val-model",
    input: "Think carefully.",
    reasoning: { effort: "high", summary: "detailed" },
    stream: true,
  });
  const accumulator = new ChatAccumulator("val-model", { created: 789 });
  const adapter = new ResponsesAdapter(request, accumulator, {
    id: "resp_reasoning",
  });

  const initial = adapter.initialEvents();
  const reasoningChunks = accumulator.consume({
    kind: "openai",
    data: {
      choices: [
        {
          delta: {
            reasoning_content: "First check the constraints.",
          },
          finish_reason: null,
        },
      ],
    },
  });
  const reasoningEvents = reasoningChunks.flatMap((chunk) =>
    adapter.eventsFromChunk(chunk),
  );
  const answerChunks = accumulator.consume({
    kind: "delta",
    content: "The result is 42.",
  });
  const answerEvents = answerChunks.flatMap((chunk) =>
    adapter.eventsFromChunk(chunk),
  );
  accumulator.consume({
    kind: "usage",
    usage: {
      prompt_tokens: 8,
      completion_tokens: 12,
      total_tokens: 20,
      completion_tokens_details: {
        reasoning_tokens: 7,
      },
    },
  });
  const final = adapter.finalEvents();
  const allEvents = [...initial, ...reasoningEvents, ...answerEvents, ...final];
  const eventTypes = allEvents.map((event) => event.type);

  assert.deepEqual(
    reasoningEvents.map((event) => event.type),
    [
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
    ],
  );
  assert.ok(eventTypes.includes("response.reasoning_summary_text.done"));
  assert.ok(eventTypes.includes("response.reasoning_summary_part.done"));
  const completed = final.at(-1) as {
    response?: {
      output?: Array<Record<string, unknown>>;
      usage?: {
        output_tokens_details?: { reasoning_tokens?: number };
      };
    };
  };
  assert.equal(completed.response?.output?.[0]?.type, "reasoning");
  assert.deepEqual(completed.response?.output?.[0]?.summary, [
    {
      type: "summary_text",
      text: "First check the constraints.",
    },
  ]);
  assert.equal(completed.response?.output?.[1]?.type, "message");
  assert.equal(
    completed.response?.usage?.output_tokens_details?.reasoning_tokens,
    7,
  );
  assert.deepEqual(
    allEvents.map((event) => event.sequence_number),
    Array.from({ length: allEvents.length }, (_, index) => index),
  );
});

test("produces schema-valid Responses error events after streaming starts", () => {
  const request = parseResponse({
    model: "val-model",
    input: "Fail after accepting.",
    stream: true,
  });
  const adapter = new ResponsesAdapter(
    request,
    new ChatAccumulator("val-model"),
  );
  const initial = adapter.initialEvents();
  const [errorEvent] = adapter.errorEvents({
    code: "val_upstream_error",
    message: "Val rejected the continuation.",
  });

  assert.equal(errorEvent?.type, "error");
  assert.equal(errorEvent?.sequence_number, initial.length);
  assert.equal(errorEvent?.code, "val_upstream_error");
  assert.equal(errorEvent?.message, "Val rejected the continuation.");
});
