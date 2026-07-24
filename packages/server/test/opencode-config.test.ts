import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  configureOpenCode,
  openAIModelCapabilities,
  reasoningCapabilitiesForModel,
  reasoningLevelsForModel,
} from "../src/opencode-config.js";

const clientApiKey = `val-local-${"a".repeat(43)}`;
const baseURL = "http://127.0.0.1:8787/v1";

test("merges the Val provider, preserves unrelated config, and writes a backup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "val-opencode-config-"));
  const configPath = join(root, "opencode.jsonc");
  const original = `{
  // Keep this provider and comment.
  "provider": {
    "other": {
      "name": "Other Provider"
    },
    "val": {
      "customSetting": true,
      "options": {
        "customOption": "keep"
      },
      "models": {
        "openai-gpt-5.6-luna": {
          "customModelSetting": "keep"
        },
        "custom-model": {
          "name": "Keep Me"
        }
      }
    }
  },
  "theme": "system"
}
`;
  await writeFile(configPath, original, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await configureOpenCode({
    baseURL,
    clientApiKey,
    configPath,
    now: new Date("2026-07-24T01:02:03.456Z"),
    models: [
      { id: "openai-gpt-5.6-luna", name: "OpenAI GPT-5.6 Luna" },
      { id: "plain-model", name: "Plain Model" },
    ],
  });

  assert.equal(result.updated, true);
  assert.equal(result.modelsConfigured, 1);
  assert.ok(result.backupPath);
  assert.equal(await readFile(result.backupPath, "utf8"), original);

  const updatedText = await readFile(configPath, "utf8");
  assert.match(updatedText, /Keep this provider and comment/);
  const updated = parse(updatedText) as Record<string, unknown>;
  const providers = updated.provider as Record<string, Record<string, unknown>>;
  assert.equal(providers.other?.name, "Other Provider");
  assert.equal(updated.theme, "system");

  const val = providers.val;
  assert.equal(val?.npm, "@ai-sdk/openai");
  assert.equal(val?.customSetting, true);
  const options = val?.options as Record<string, unknown>;
  assert.equal(options.customOption, "keep");
  assert.equal(options.baseURL, baseURL);
  assert.equal(options.apiKey, clientApiKey);
  const models = val?.models as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(models), ["openai-gpt-5.6-luna"]);
  assert.equal(models["openai-gpt-5.6-luna"]?.customModelSetting, "keep");
  assert.equal(models["openai-gpt-5.6-luna"]?.reasoning, true);
  assert.deepEqual(models["openai-gpt-5.6-luna"]?.limit, {
    context: 1_050_000,
    output: 128_000,
  });
  assert.deepEqual(
    Object.keys(
      models["openai-gpt-5.6-luna"]?.variants as Record<string, unknown>,
    ),
    ["low", "medium", "high", "xhigh", "max", "max-detailed"],
  );
  assert.deepEqual(
    (
      models["openai-gpt-5.6-luna"]?.variants as Record<
        string,
        Record<string, unknown>
      >
    ).high,
    {
      reasoningEffort: "high",
      reasoningSummary: "auto",
      reasoningContext: "all_turns",
    },
  );
  assert.deepEqual(
    (
      models["openai-gpt-5.6-luna"]?.variants as Record<
        string,
        Record<string, unknown>
      >
    ).max,
    {
      reasoningEffort: "max",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
      reasoningContext: "all_turns",
    },
  );
  assert.deepEqual(
    (
      models["openai-gpt-5.6-luna"]?.variants as Record<
        string,
        Record<string, unknown>
      >
    )["max-detailed"],
    {
      reasoningEffort: "max",
      reasoningSummary: "detailed",
      include: ["reasoning.encrypted_content"],
      reasoningContext: "all_turns",
    },
  );
});

test("does not rewrite or back up an already configured file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "val-opencode-idempotent-"));
  const configPath = join(root, "opencode.jsonc");
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    baseURL,
    clientApiKey,
    configPath,
    models: [{ id: "openai-gpt-5.6-sol", name: "OpenAI GPT-5.6 Sol" }],
  };

  const first = await configureOpenCode(options);
  const firstText = await readFile(configPath, "utf8");
  const second = await configureOpenCode(options);
  const files = await readdir(root);

  assert.equal(first.updated, true);
  assert.equal(second.updated, false);
  assert.equal(second.backupPath, undefined);
  assert.equal(await readFile(configPath, "utf8"), firstText);
  assert.deepEqual(files, ["opencode.jsonc"]);
});

test("refuses invalid JSONC without changing the file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "val-opencode-invalid-"));
  const configPath = join(root, "opencode.jsonc");
  const invalid = '{ "provider": {';
  await writeFile(configPath, invalid, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    configureOpenCode({
      baseURL,
      clientApiKey,
      configPath,
      models: [{ id: "openai-gpt-5.6-terra" }],
    }),
    /No changes were made/,
  );
  assert.equal(await readFile(configPath, "utf8"), invalid);
  assert.deepEqual(await readdir(root), ["opencode.jsonc"]);
});

test("refuses to export an OpenCode provider without a GPT-5.6 model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "val-opencode-model-filter-"));
  const configPath = join(root, "opencode.jsonc");
  const original = '{ "theme": "system" }\n';
  await writeFile(configPath, original, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    configureOpenCode({
      baseURL,
      clientApiKey,
      configPath,
      models: [{ id: "plain-model", name: "Plain Model" }],
    }),
    /OpenAI GPT-5\.6/,
  );
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.deepEqual(await readdir(root), ["opencode.jsonc"]);
});

test("uses reasoning levels exposed in nested Val model features", () => {
  assert.deepEqual(
    reasoningLevelsForModel({
      id: "reasoning-model",
      features: {
        chat: {
          settings: {
            reasoning_effort: {
              values: ["low", "high", "ultra", "unsupported"],
            },
          },
        },
      },
    }),
    ["low", "high", "ultra"],
  );
});

test("preserves explicit levels plus the GPT-5.6 max family variant", () => {
  assert.deepEqual(
    reasoningLevelsForModel({
      id: "openai-gpt-5.6-terra",
      features: {
        chat: {
          settings: {
            reasoning_effort: {
              values: ["low", "high"],
            },
          },
        },
      },
    }),
    ["low", "high", "max"],
  );
});

test("uses GPT-5.6 family defaults only when Val exposes no capability metadata", () => {
  assert.deepEqual(
    reasoningCapabilitiesForModel({
      id: "openai-gpt-5.6-terra",
    }),
    {
      levels: ["low", "medium", "high", "xhigh", "max"],
      summaryModes: ["auto", "detailed"],
      effortSource: "gpt_5_6_family",
      summarySource: "gpt_5_6_family",
    },
  );
});

test("honors explicit reasoning and summary capability restrictions", () => {
  const disabled = {
    id: "openai-gpt-5.6-sol",
    features: {
      chat: {
        supports_reasoning: false,
        supports_reasoning_summary: false,
      },
    },
  };
  assert.deepEqual(reasoningLevelsForModel(disabled), []);

  const explicit = {
    id: "openai-gpt-5.6-sol",
    features: {
      chat: {
        settings: {
          reasoning_effort: { values: ["high", "max"] },
          reasoning_summary: { values: ["auto"] },
        },
      },
    },
  };
  assert.deepEqual(reasoningCapabilitiesForModel(explicit), {
    levels: ["high", "max"],
    summaryModes: ["auto"],
    effortSource: "val_metadata",
    summarySource: "val_metadata",
  });
});

test("advertises context and reasoning evidence without exposing raw model data", () => {
  assert.deepEqual(
    openAIModelCapabilities({
      id: "openai-gpt-5.6-luna",
      features: {
        chat: {
          settings: {
            reasoning_effort: { values: ["low", "max"] },
            reasoning_summary: { values: ["auto", "detailed"] },
          },
        },
      },
    }),
    {
      context_window: 1_050_000,
      max_output_tokens: 128_000,
      val_capabilities: {
        reasoning: true,
        reasoning_efforts: ["low", "max"],
        reasoning_summaries: ["auto", "detailed"],
        evidence: {
          effort: "val_metadata",
          summary: "val_metadata",
        },
      },
    },
  );
});
