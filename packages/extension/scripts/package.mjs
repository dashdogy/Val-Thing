import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const extensionRoot = resolve(import.meta.dirname, "..");
const projectRoot = resolve(extensionRoot, "..", "..");
const inputDirectory = resolve(extensionRoot, "dist");
const releaseDirectory = resolve(projectRoot, "release");
const allowedRootFiles = new Set([
  "background.js",
  "content.js",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
]);

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
      throw new Error(`Release input contains an unsupported entry: ${path}`);
    }
  }
  return files;
}

function validateReleaseFiles(names) {
  if (!names.includes("manifest.json")) {
    throw new Error(
      "The release package is missing manifest.json at its root.",
    );
  }
  for (const name of names) {
    const allowed =
      allowedRootFiles.has(name) ||
      /^icons\/icon-(16|32|48|128)\.png$/.test(name);
    if (!allowed) {
      throw new Error(`Unexpected release file: ${name}`);
    }
    if (name.endsWith(".map") || name.endsWith(".ts")) {
      throw new Error(`Development source leaked into the release: ${name}`);
    }
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

const manifest = JSON.parse(
  await readFile(resolve(inputDirectory, "manifest.json"), "utf8"),
);
if (typeof manifest.version !== "string") {
  throw new Error("The built manifest has no valid version.");
}
const versionFiles = [
  resolve(projectRoot, "package.json"),
  resolve(projectRoot, "packages", "protocol", "package.json"),
  resolve(projectRoot, "packages", "server", "package.json"),
  resolve(extensionRoot, "package.json"),
];
const packageVersions = await Promise.all(
  versionFiles.map(async (path) => {
    const packageJson = JSON.parse(await readFile(path, "utf8"));
    return { path, version: packageJson.version };
  }),
);
for (const item of packageVersions) {
  if (item.version !== manifest.version) {
    throw new Error(
      `Release version mismatch: ${item.path} is ${item.version}; expected ${manifest.version}.`,
    );
  }
}

const paths = await collectFiles(inputDirectory);
const entries = (
  await Promise.all(
    paths.map(async (path) => ({
      name: zipPath(relative(inputDirectory, path)),
      data: await readFile(path),
    })),
  )
).sort((left, right) => left.name.localeCompare(right.name));

validateReleaseFiles(entries.map((entry) => entry.name));
for (const path of paths) {
  const details = await stat(path);
  if (details.size >= 0xffffffff) {
    throw new Error(`ZIP64 is not supported for release file: ${path}`);
  }
}

const localParts = [];
const centralParts = [];
let offset = 0;
for (const entry of entries) {
  const compressed = deflateRawSync(entry.data, { level: 9 });
  const local = localHeader(entry.name, entry.data, compressed);
  localParts.push(local);
  centralParts.push(centralHeader(entry.name, entry.data, compressed, offset));
  offset += local.length;
}

const centralDirectory = Buffer.concat(centralParts);
const archive = Buffer.concat([
  ...localParts,
  centralDirectory,
  endOfCentralDirectory(entries.length, centralDirectory.length, offset),
]);
const archiveName = `val-openai-local-bridge-extension-${manifest.version}.zip`;
const archivePath = resolve(releaseDirectory, archiveName);
const checksum = createHash("sha256").update(archive).digest("hex");

await mkdir(releaseDirectory, { recursive: true });
await writeFile(archivePath, archive);
await writeFile(
  `${archivePath}.sha256`,
  `${checksum}  ${archiveName}\n`,
  "utf8",
);

console.log(`Packaged ${entries.length} files: ${archivePath}`);
console.log(`SHA-256: ${checksum}`);
