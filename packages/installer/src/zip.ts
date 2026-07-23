import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;

type CentralEntry = {
  name: string;
  flags: number;
  method: number;
  checksum: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttributes: number;
  localOffset: number;
};

function findEndRecord(archive: Buffer) {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw new Error("The ZIP archive has no end record.");
}

function validateEntryName(name: string) {
  const parts = name.split("/");
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    isAbsolute(name) ||
    parts.some(
      (part) =>
        !part || part === "." || part === ".." || /^[A-Za-z]:$/.test(part),
    )
  ) {
    throw new Error(`Unsafe ZIP entry: ${name}`);
  }
}

function parseCentralEntries(archive: Buffer) {
  if (archive.length < 22) {
    throw new Error("The ZIP archive is truncated.");
  }
  const endOffset = findEndRecord(archive);
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0 ||
    totalEntries > MAX_ARCHIVE_ENTRIES ||
    centralOffset + centralSize > endOffset
  ) {
    throw new Error("Unsupported ZIP archive layout.");
  }

  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > archive.length ||
      archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE
    ) {
      throw new Error("The ZIP central directory is invalid.");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.length) {
      throw new Error("The ZIP central directory is truncated.");
    }
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    validateEntryName(name);
    if (names.has(name)) {
      throw new Error(`Duplicate ZIP entry: ${name}`);
    }
    if (
      flags & ~0x0808 ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      throw new Error(`Unsupported ZIP entry: ${name}`);
    }
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    if (fileType !== 0 && fileType !== 0o100000) {
      throw new Error(`Non-regular ZIP entry: ${name}`);
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error("The expanded ZIP archive is too large.");
    }
    names.add(name);
    entries.push({
      name,
      flags,
      method,
      checksum,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      localOffset,
    });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error("The ZIP central directory length is invalid.");
  }
  return entries;
}

function entryData(archive: Buffer, entry: CentralEntry) {
  const offset = entry.localOffset;
  if (
    offset + 30 > archive.length ||
    archive.readUInt32LE(offset) !== LOCAL_SIGNATURE
  ) {
    throw new Error(`Invalid local ZIP header: ${entry.name}`);
  }
  const localFlags = archive.readUInt16LE(offset + 6);
  const localMethod = archive.readUInt16LE(offset + 8);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const localName = archive
    .subarray(offset + 30, offset + 30 + nameLength)
    .toString("utf8");
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (
    localFlags !== entry.flags ||
    localMethod !== entry.method ||
    localName !== entry.name ||
    dataEnd > archive.length
  ) {
    throw new Error(`Invalid ZIP entry data: ${entry.name}`);
  }
  const compressed = archive.subarray(dataOffset, dataEnd);
  const data =
    entry.method === 0
      ? compressed
      : inflateRawSync(compressed, {
          maxOutputLength: Math.max(entry.uncompressedSize, 1),
        });
  if (
    data.length !== entry.uncompressedSize ||
    crc32(data) >>> 0 !== entry.checksum
  ) {
    throw new Error(`ZIP integrity check failed: ${entry.name}`);
  }
  return data;
}

export async function extractZip(archive: Buffer, destination: string) {
  const root = resolve(destination);
  const entries = parseCentralEntries(archive);
  await mkdir(root, { recursive: true });
  for (const entry of entries) {
    const output = resolve(root, ...entry.name.split("/"));
    const relation = relative(root, output);
    if (
      !relation ||
      relation === ".." ||
      relation.startsWith("../") ||
      relation.startsWith("..\\") ||
      isAbsolute(relation)
    ) {
      throw new Error(`Unsafe ZIP output path: ${entry.name}`);
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, entryData(archive, entry), {
      mode: entry.externalAttributes >>> 16,
    });
  }
  return entries.map((entry) => entry.name);
}
