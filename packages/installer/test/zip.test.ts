import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeterministicZip } from "../../../scripts/deterministic-zip.mjs";
import { extractZip } from "../src/zip.js";

test("extracts the deterministic portable release format", async (t) => {
  const destination = await mkdtemp(join(tmpdir(), "bridge-zip-test-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const archive = createDeterministicZip([
    { name: "extension/manifest.json", data: Buffer.from("{}") },
    { name: "server.mjs", data: Buffer.from("export {};") },
  ]);

  const names = await extractZip(archive, destination);
  assert.deepEqual(names, ["extension/manifest.json", "server.mjs"]);
  assert.equal(
    await readFile(join(destination, "server.mjs"), "utf8"),
    "export {};",
  );
});

test("rejects traversal names before writing files", async (t) => {
  const destination = await mkdtemp(join(tmpdir(), "bridge-zip-safe-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const archive = createDeterministicZip([
    { name: "aa/evil", data: Buffer.from("no") },
  ]);
  const safeName = Buffer.from("aa/evil");
  const unsafeName = Buffer.from("../evil");
  let offset = archive.indexOf(safeName);
  while (offset >= 0) {
    unsafeName.copy(archive, offset);
    offset = archive.indexOf(safeName, offset + safeName.length);
  }

  await assert.rejects(extractZip(archive, destination), /Unsafe ZIP entry/);
});
