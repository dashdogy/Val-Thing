import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

function zipPath(path) {
  return path.split(sep).join("/");
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`ZIP input contains an unsupported entry: ${path}`);
    }
  }
  return files;
}

export async function entriesFromDirectory(directory) {
  const root = resolve(directory);
  const paths = await collectFiles(root);
  const entries = await Promise.all(
    paths.map(async (path) => {
      const details = await stat(path);
      if (details.size >= 0xffffffff) {
        throw new Error(`ZIP64 is not supported for release file: ${path}`);
      }
      return {
        name: zipPath(relative(root, path)),
        data: await readFile(path),
      };
    }),
  );
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function validateEntries(entries) {
  if (entries.length === 0) {
    throw new Error("A release archive cannot be empty.");
  }
  if (entries.length >= 0xffff) {
    throw new Error("ZIP64 is not supported for this release archive.");
  }

  const names = new Set();
  for (const entry of entries) {
    if (
      !entry.name ||
      entry.name.startsWith("/") ||
      entry.name.includes("\\") ||
      entry.name.split("/").includes("..")
    ) {
      throw new Error(`Unsafe ZIP entry name: ${entry.name}`);
    }
    if (names.has(entry.name)) {
      throw new Error(`Duplicate ZIP entry name: ${entry.name}`);
    }
    if (entry.data.length >= 0xffffffff) {
      throw new Error(`ZIP64 is not supported for: ${entry.name}`);
    }
    names.add(entry.name);
  }
}

function localHeader(name, data, compressed) {
  const nameBuffer = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc32(data) >>> 0, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuffer, compressed]);
}

function centralHeader(name, data, compressed, offset) {
  const nameBuffer = Buffer.from(name, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(crc32(data) >>> 0, 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBuffer]);
}

function endOfCentralDirectory(fileCount, centralSize, centralOffset) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(fileCount, 8);
  footer.writeUInt16LE(fileCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

export function createDeterministicZip(entries) {
  validateEntries(entries);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const local = localHeader(entry.name, entry.data, compressed);
    localParts.push(local);
    centralParts.push(
      centralHeader(entry.name, entry.data, compressed, offset),
    );
    offset += local.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (offset >= 0xffffffff || centralDirectory.length >= 0xffffffff) {
    throw new Error("ZIP64 is not supported for this release archive.");
  }
  return Buffer.concat([
    ...localParts,
    centralDirectory,
    endOfCentralDirectory(entries.length, centralDirectory.length, offset),
  ]);
}

export async function writeDeterministicZip(directory, outputPath) {
  const entries = await entriesFromDirectory(directory);
  const archive = createDeterministicZip(entries);
  await writeFile(outputPath, archive);
  return {
    entries: entries.length,
    size: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}
