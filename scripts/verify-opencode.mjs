import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const TOOL_FILE_CONTENT = "VAL_BRIDGE_TOOL_PROBE_OK";
const FINAL_MARKER = "OPENCODE_TOOL_ACCEPTANCE_OK";
const REASONING_MARKER = "The read tool result was received.";

async function executableExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function commandOnPath() {
  const lookup =
    process.platform === "win32"
      ? spawnSync("where.exe", ["opencode"], { encoding: "utf8" })
      : spawnSync("sh", ["-lc", "command -v opencode"], {
          encoding: "utf8",
        });
  if (lookup.status !== 0) return undefined;
  return lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

async function findRecursively(root, expectedBasename, depth = 0) {
  if (depth > 5) return undefined;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && basename(path) === expectedBasename) return path;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findRecursively(
      join(root, entry.name),
      expectedBasename,
      depth + 1,
    );
    if (found) return found;
  }
  return undefined;
}

async function resolveOpenCodeBinary() {
  const configured = process.env.OPENCODE_BIN?.trim();
  if (configured) {
    const path = resolve(configured);
    if (!(await executableExists(path))) {
      throw new Error(`OPENCODE_BIN does not exist: ${path}`);
    }
    return path;
  }
  const fromPath = commandOnPath();
  if (fromPath) return fromPath;

  const executable = process.platform === "win32" ? "opencode.exe" : "opencode";
  const roots =
    process.platform === "win32"
      ? [
          join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx"),
          join(process.env.LOCALAPPDATA ?? "", "opencode", "bin"),
        ]
      : [
          join(homedir(), ".npm", "_npx"),
          join(homedir(), ".cache", "opencode", "bin"),
          join(homedir(), ".opencode", "bin"),
        ];
  for (const root of roots.filter(Boolean)) {
    const found = await findRecursively(root, executable);
    if (found) return found;
  }
  throw new Error(
    "OpenCode was not found. Install it or set OPENCODE_BIN to its executable.",
  );
}

function readRequestBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function usage() {
  return {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 8,
    output_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 20,
  };
}

function baseResponse(id, output, status = "completed") {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "tool-model",
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: "max", summary: "detailed" },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: usage(),
    metadata: {},
  };
}

function toolResponseEvents(argumentsJson) {
  const id = "resp_tool_acceptance";
  const callId = "call_read_acceptance";
  const itemId = "fc_read_acceptance";
  const item = {
    id: itemId,
    type: "function_call",
    status: "completed",
    arguments: argumentsJson,
    call_id: callId,
    name: "read",
  };
  const response = baseResponse(id, [item]);
  return [
    {
      type: "response.created",
      response: baseResponse(id, [], "in_progress"),
    },
    {
      type: "response.in_progress",
      response: baseResponse(id, [], "in_progress"),
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsJson,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: argumentsJson,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item,
    },
    { type: "response.completed", response },
  ];
}

function finalResponseEvents() {
  const id = "resp_final_acceptance";
  const reasoningId = "rs_acceptance";
  const messageId = "msg_acceptance";
  const reasoningItem = {
    id: reasoningId,
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: REASONING_MARKER }],
  };
  const messageItem = {
    id: messageId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: FINAL_MARKER,
        annotations: [],
        logprobs: [],
      },
    ],
  };
  const response = baseResponse(id, [reasoningItem, messageItem]);
  return [
    {
      type: "response.created",
      response: baseResponse(id, [], "in_progress"),
    },
    {
      type: "response.in_progress",
      response: baseResponse(id, [], "in_progress"),
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        ...reasoningItem,
        status: "in_progress",
        summary: [],
      },
    },
    {
      type: "response.reasoning_summary_part.added",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      delta: REASONING_MARKER,
    },
    {
      type: "response.reasoning_summary_text.done",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      text: REASONING_MARKER,
    },
    {
      type: "response.reasoning_summary_part.done",
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: REASONING_MARKER },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: reasoningItem,
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        ...messageItem,
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: 1,
      content_index: 0,
      part: {
        type: "output_text",
        text: "",
        annotations: [],
        logprobs: [],
      },
    },
    {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 1,
      content_index: 0,
      delta: FINAL_MARKER,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 1,
      content_index: 0,
      text: FINAL_MARKER,
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: 1,
      content_index: 0,
      part: messageItem.content[0],
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: messageItem,
    },
    { type: "response.completed", response },
  ];
}

function writeSse(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const [sequenceNumber, event] of events.entries()) {
    const completeEvent = { sequence_number: sequenceNumber, ...event };
    response.write(`event: ${completeEvent.type}\n`);
    response.write(`data: ${JSON.stringify(completeEvent)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function runProcess(binary, args, options, timeoutMs = 60_000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`OpenCode acceptance timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

const openCodeBinary = await resolveOpenCodeBinary();
const temporaryRoot = await mkdtemp(join(tmpdir(), "val-opencode-acceptance-"));
const workspace = join(temporaryRoot, "workspace");
const probePath = join(workspace, "probe.txt");
await mkdir(workspace, { recursive: true });
await writeFile(probePath, `${TOOL_FILE_CONTENT}\n`, "utf8");

const requests = [];
const mock = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "tool-model",
              object: "model",
              created: 0,
              owned_by: "acceptance",
            },
          ],
        }),
      );
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const body = await readRequestBody(request);
    requests.push(body);
    const serialized = JSON.stringify(body);
    const hasToolOutput =
      serialized.includes("function_call_output") ||
      serialized.includes(TOOL_FILE_CONTENT);
    if (!hasToolOutput) {
      const tools = Array.isArray(body.tools) ? body.tools : [];
      if (!tools.some((tool) => tool?.name === "read")) {
        throw new Error("OpenCode did not expose its read tool to the model.");
      }
      writeSse(
        response,
        toolResponseEvents(JSON.stringify({ filePath: probePath })),
      );
      return;
    }
    writeSse(response, finalResponseEvents());
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  }
});

await new Promise((resolveListen, reject) => {
  mock.once("error", reject);
  mock.listen(0, "127.0.0.1", resolveListen);
});
const address = mock.address();
if (!address || typeof address === "string") {
  throw new Error("The OpenCode acceptance mock did not bind an IPv4 port.");
}
const baseURL = `http://127.0.0.1:${address.port}/v1`;

const config = {
  $schema: "https://opencode.ai/config.json",
  provider: {
    "val-acceptance": {
      npm: "@ai-sdk/openai",
      name: "Val acceptance mock",
      options: {
        baseURL,
        apiKey: "acceptance-only",
        timeout: 30_000,
      },
      models: {
        "tool-model": {
          name: "Tool acceptance model",
          reasoning: true,
          tool_call: true,
          variants: {
            "max-detailed": {
              reasoningEffort: "max",
              reasoningSummary: "detailed",
              include: ["reasoning.encrypted_content"],
            },
          },
          modalities: {
            input: ["text"],
            output: ["text"],
          },
        },
      },
    },
  },
};

let run;
try {
  run = await runProcess(
    openCodeBinary,
    [
      "run",
      "--pure",
      "--format",
      "json",
      "--thinking",
      "--auto",
      "--model",
      "val-acceptance/tool-model",
      "--variant",
      "max-detailed",
      "--dir",
      workspace,
      "Use the read tool to read probe.txt, then report completion.",
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        NO_COLOR: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        XDG_CACHE_HOME: join(temporaryRoot, "cache"),
        XDG_CONFIG_HOME: join(temporaryRoot, "config"),
        XDG_DATA_HOME: join(temporaryRoot, "data"),
        XDG_STATE_HOME: join(temporaryRoot, "state"),
      },
    },
  );
} finally {
  await new Promise((resolveClose) => mock.close(resolveClose));
}

try {
  if (run.code !== 0) {
    throw new Error(
      `OpenCode exited with ${run.code ?? run.signal}.\n${run.stderr || run.stdout}`,
    );
  }
  if (requests.length < 2) {
    throw new Error(
      `Expected a tool round-trip, but OpenCode made ${requests.length} Responses request(s).`,
    );
  }
  const continuation = JSON.stringify(requests.slice(1));
  if (
    !continuation.includes("function_call_output") ||
    !continuation.includes(TOOL_FILE_CONTENT)
  ) {
    throw new Error(
      "OpenCode did not return the read tool output to the Responses API.",
    );
  }
  if (!run.stdout.includes(FINAL_MARKER)) {
    throw new Error("OpenCode did not render the final model response.");
  }
  if (!run.stdout.includes(REASONING_MARKER)) {
    throw new Error("OpenCode did not expose the genuine reasoning summary.");
  }
  console.log(
    `OpenCode ${run.stdout.includes(REASONING_MARKER) ? "accepted" : "rejected"} the bridge contract.`,
  );
  console.log(`Binary: ${openCodeBinary}`);
  console.log(
    "Verified: Responses API, read tool round-trip, reasoning summary.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
