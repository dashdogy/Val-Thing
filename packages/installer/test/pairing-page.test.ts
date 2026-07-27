import assert from "node:assert/strict";
import test from "node:test";
import {
  pairingPageLaunchCommand,
  pairingPageUrl,
} from "../src/pairing-page.js";

test("opens the local pairing page visibly for Windows protocol launches", () => {
  assert.equal(pairingPageUrl(8787), "http://127.0.0.1:8787/pairing");
  assert.deepEqual(pairingPageLaunchCommand("win32", 8787), {
    file: "rundll32.exe",
    arguments: ["url.dll,FileProtocolHandler", "http://127.0.0.1:8787/pairing"],
  });
});

test("leaves platforms with visible terminal launchers unchanged", () => {
  assert.equal(pairingPageLaunchCommand("darwin", 8787), undefined);
  assert.equal(pairingPageLaunchCommand("linux", 8787), undefined);
  assert.throws(() => pairingPageUrl(0), /port is invalid/);
  assert.throws(() => pairingPageUrl(65_536), /port is invalid/);
});
