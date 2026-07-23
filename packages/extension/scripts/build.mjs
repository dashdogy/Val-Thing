import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import sharp from "sharp";

const extensionRoot = resolve(import.meta.dirname, "..");
const sourceDirectory = resolve(extensionRoot, "src");
const outputDirectory = resolve(extensionRoot, "dist");
const releaseBuild = process.argv.includes("--release");
const iconSizes = [16, 32, 48, 128];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validateManifest(manifest, packageJson) {
  assert(
    manifest.manifest_version === 3,
    "The extension must use Manifest V3.",
  );
  assert(
    manifest.version === packageJson.version,
    `Manifest version ${manifest.version} does not match package version ${packageJson.version}.`,
  );
  assert(
    typeof manifest.description === "string" &&
      manifest.description.length <= 132,
    "The extension description must be no more than 132 characters.",
  );

  const permissions = new Set(manifest.permissions ?? []);
  assert(
    permissions.size === 1 && permissions.has("storage"),
    "Release builds may request only the storage API permission.",
  );

  const hostPermissions = new Set(manifest.host_permissions ?? []);
  const expectedHosts = new Set([
    "https://val.rmit.edu.au/*",
    "http://127.0.0.1/*",
  ]);
  assert(
    hostPermissions.size === expectedHosts.size &&
      [...expectedHosts].every((host) => hostPermissions.has(host)),
    "Release host permissions must remain limited to Val and IPv4 loopback.",
  );

  const contentMatches = manifest.content_scripts?.flatMap(
    (script) => script.matches ?? [],
  );
  assert(
    contentMatches?.length === 1 &&
      contentMatches[0] === "https://val.rmit.edu.au/*",
    "The content script must match only https://val.rmit.edu.au/*.",
  );
}

async function bundle(entryPoint, outputFile, format) {
  await build({
    entryPoints: [resolve(sourceDirectory, entryPoint)],
    outfile: resolve(outputDirectory, outputFile),
    bundle: true,
    format,
    platform: "browser",
    target: "chrome116",
    charset: "utf8",
    legalComments: "none",
    minify: releaseBuild,
    sourcemap: releaseBuild ? false : "linked",
  });
}

const [manifest, packageJson, iconSource] = await Promise.all([
  loadJson(resolve(sourceDirectory, "manifest.json")),
  loadJson(resolve(extensionRoot, "package.json")),
  readFile(resolve(sourceDirectory, "icon.svg")),
]);
validateManifest(manifest, packageJson);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await Promise.all([
  bundle("background.ts", "background.js", "esm"),
  bundle("content.ts", "content.js", "iife"),
  bundle("popup.ts", "popup.js", "iife"),
]);

await Promise.all(
  ["manifest.json", "popup.html", "popup.css"].map((file) =>
    cp(resolve(sourceDirectory, file), resolve(outputDirectory, file)),
  ),
);

const iconDirectory = resolve(outputDirectory, "icons");
await mkdir(iconDirectory, { recursive: true });
await Promise.all(
  iconSizes.map((size) =>
    sharp(iconSource, { density: 384 })
      .resize(size, size)
      .png({ compressionLevel: 9, palette: true })
      .toFile(resolve(iconDirectory, `icon-${size}.png`)),
  ),
);

console.log(
  `Built ${releaseBuild ? "release" : "development"} extension at ${outputDirectory}`,
);
