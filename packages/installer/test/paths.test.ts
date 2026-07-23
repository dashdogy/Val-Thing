import assert from "node:assert/strict";
import test from "node:test";
import { join, posix, win32 } from "node:path";
import {
  defaultInstallRoot,
  isPathInside,
  runtimePaths,
} from "../src/paths.js";

test("chooses a conventional install root on each supported OS", () => {
  assert.equal(
    defaultInstallRoot({
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\Users\\friend\\AppData\\Local" },
      homeDirectory: "C:\\Users\\friend",
    }),
    win32.join("C:\\Users\\friend\\AppData\\Local", "ValOpenAIBridge"),
  );
  assert.equal(
    defaultInstallRoot({
      platform: "darwin",
      environment: {},
      homeDirectory: "/Users/friend",
    }),
    posix.join(
      "/Users/friend",
      "Library",
      "Application Support",
      "ValOpenAIBridge",
    ),
  );
  assert.equal(
    defaultInstallRoot({
      platform: "linux",
      environment: { XDG_DATA_HOME: "/home/friend/.data" },
      homeDirectory: "/home/friend",
    }),
    posix.join("/home/friend/.data", "val-openai-bridge"),
  );
});

test("runtime paths stay within the selected install root", () => {
  const paths = runtimePaths(join(process.cwd(), ".tmp", "install-root"));
  assert.equal(isPathInside(paths.root, paths.runtime), true);
  assert.equal(isPathInside(paths.runtime, paths.extension), true);
  assert.equal(isPathInside(paths.runtime, join(paths.root, "outside")), false);
});
