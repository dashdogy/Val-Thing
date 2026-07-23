import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  configureOpenCode,
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
  assert.equal(result.modelsConfigured, 2);
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
  assert.equal(models["custom-model"]?.name, "Keep Me");
  assert.equal(models["openai-gpt-5.6-luna"]?.reasoning, true);
  assert.deepEqual(
    Object.keys(
      models["openai-gpt-5.6-luna"]?.variants as Record<string, unknown>,
    ),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.ok(!("reasoning" in (models["plain-model"] ?? {})));
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
