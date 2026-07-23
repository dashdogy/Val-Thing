import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { extractZip } from "../packages/installer/dist/zip.js";

const projectRoot = resolve(import.meta.dirname, "..");
const releaseDirectory = join(projectRoot, "release");
const manifest = JSON.parse(
  await readFile(join(releaseDirectory, "latest.json"), "utf8"),
);
const portablePath = join(
  releaseDirectory,
  manifest.assets.portable_bundle.name,
);
const extensionPath = join(releaseDirectory, manifest.assets.extension.name);
const installerPath = join(releaseDirectory, manifest.assets.installer.name);
const oneLineInstallerPath = join(releaseDirectory, "install.tgz");
const portable = await readFile(portablePath);
const extension = await readFile(extensionPath);
const installer = await readFile(installerPath);
const oneLineInstaller = await readFile(oneLineInstallerPath);
const latest = await readFile(join(releaseDirectory, "latest.json"));
const checksums = await readFile(
  join(releaseDirectory, "SHA256SUMS.txt"),
  "utf8",
);

assert.equal(portable.length, manifest.assets.portable_bundle.size);
assert.equal(
  createHash("sha256").update(portable).digest("hex"),
  manifest.assets.portable_bundle.sha256,
);
assert.equal(extension.length, manifest.assets.extension.size);
assert.equal(installer.length, manifest.assets.installer.size);
assert.match(
  checksums,
  new RegExp(
    `${createHash("sha256").update(oneLineInstaller).digest("hex")}  install\\.tgz`,
  ),
);

const temporaryRoot = await mkdtemp(
  join(tmpdir(), "val-bridge-portable-test-"),
);
const extractedRoot = join(temporaryRoot, "extracted");
const installRoot = join(temporaryRoot, "installed");
let mockOrigin = "";

function send(response, body, contentType) {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

const github = () => ({
  tag_name: manifest.source.tag,
  html_url: `${manifest.source.repository}/releases/tag/${manifest.source.tag}`,
  published_at: manifest.published_at,
  assets: [
    {
      name: "latest.json",
      size: latest.length,
      browser_download_url: `${mockOrigin}/latest.json`,
    },
    {
      name: manifest.assets.portable_bundle.name,
      size: portable.length,
      browser_download_url: `${mockOrigin}/portable.zip`,
    },
    {
      name: manifest.assets.extension.name,
      size: extension.length,
      browser_download_url: `${mockOrigin}/extension.zip`,
    },
    {
      name: manifest.assets.installer.name,
      size: installer.length,
      browser_download_url: `${mockOrigin}/install.mjs`,
    },
  ],
});

const mockServer = createServer((request, response) => {
  switch (request.url) {
    case "/releases/latest":
      send(response, Buffer.from(JSON.stringify(github())), "application/json");
      return;
    case "/latest.json":
      send(response, latest, "application/json");
      return;
    case "/portable.zip":
      send(response, portable, "application/zip");
      return;
    case "/extension.zip":
      send(response, extension, "application/zip");
      return;
    case "/install.mjs":
      send(response, installer, "text/javascript");
      return;
    default:
      response.writeHead(404);
      response.end();
  }
});

function runNode(arguments_, environment = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, arguments_, {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        rejectPromise(
          new Error(`Node process exited with ${code}.\n${stdout}\n${stderr}`),
        );
      }
    });
  });
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

try {
  const names = await extractZip(portable, extractedRoot);
  for (const name of [
    "server.mjs",
    "launcher.mjs",
    "update.mjs",
    "version.json",
    "extension/manifest.json",
  ]) {
    assert.ok(names.includes(name), `portable archive is missing ${name}`);
  }

  await new Promise((resolvePromise, rejectPromise) => {
    mockServer.once("error", rejectPromise);
    mockServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const mockAddress = mockServer.address();
  assert.ok(mockAddress && typeof mockAddress === "object");
  mockOrigin = `http://127.0.0.1:${mockAddress.port}`;
  const releaseApi = `${mockOrigin}/releases/latest`;
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm_execpath is required to verify install.tgz");
  const npxCli = join(dirname(npmCli), "npx-cli.js");
  const oneLineInstallerSpec = `./${relative(
    projectRoot,
    oneLineInstallerPath,
  ).replaceAll("\\", "/")}`;
  const npmEnvironment = {
    npm_config_audit: "false",
    npm_config_cache: join(temporaryRoot, "npm-cache"),
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };

  const first = await runNode(
    [
      npxCli,
      "--yes",
      oneLineInstallerSpec,
      "--install-dir",
      installRoot,
      "--release-api",
      releaseApi,
    ],
    npmEnvironment,
  );
  assert.match(
    first.stdout,
    /Installed Val Bridge/,
    `npx installer output:\n${first.stdout}\n${first.stderr}`,
  );
  const second = await runNode([
    installerPath,
    "--install-dir",
    installRoot,
    "--release-api",
    releaseApi,
  ]);
  assert.match(second.stdout, /already installed/);

  await Promise.all([
    access(join(installRoot, "runtime", "current.json")),
    access(join(installRoot, "runtime", "extension", "manifest.json")),
    access(join(installRoot, "runtime", "start.mjs")),
    access(join(installRoot, "runtime", "update.mjs")),
    access(join(installRoot, "reload-extension")),
  ]);

  const update = await runNode([
    join(installRoot, "runtime", "update.mjs"),
    "--install-dir",
    installRoot,
    "--release-api",
    releaseApi,
  ]);
  assert.match(update.stdout, /already installed/);

  const port = await unusedPort();
  const launcher = spawn(
    process.execPath,
    [
      join(installRoot, "runtime", "start.mjs"),
      "--install-dir",
      installRoot,
      "--release-api",
      "http://127.0.0.1:1/releases/latest",
    ],
    {
      cwd: installRoot,
      env: {
        ...process.env,
        VAL_BRIDGE_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let launcherOutput = "";
  let launcherError = "";
  launcher.stdout.setEncoding("utf8");
  launcher.stderr.setEncoding("utf8");
  launcher.stdout.on("data", (chunk) => {
    launcherOutput += chunk;
  });
  launcher.stderr.on("data", (chunk) => {
    launcherError += chunk;
  });
  try {
    const deadline = Date.now() + 15_000;
    let health;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
    assert.ok(
      health,
      `installed launcher failed to start: ${launcherOutput}\n${launcherError}`,
    );
    assert.equal(health.status, "degraded");
    assert.match(launcherError, /Update check failed/);
  } finally {
    const alreadyExited =
      launcher.exitCode !== null || launcher.signalCode !== null;
    const exited = alreadyExited
      ? Promise.resolve()
      : new Promise((resolvePromise) => launcher.once("exit", resolvePromise));
    if (!alreadyExited) launcher.kill("SIGTERM");
    await exited;
  }

  console.log(
    `Portable release verified on ${process.platform}: v${manifest.version}, npx install/update idempotent, offline fallback healthy.`,
  );
} finally {
  const closed = new Promise((resolvePromise) =>
    mockServer.close(resolvePromise),
  );
  mockServer.closeAllConnections();
  await closed;
  await rm(temporaryRoot, { recursive: true, force: true });
}
