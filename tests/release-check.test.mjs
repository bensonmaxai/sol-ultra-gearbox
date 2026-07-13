import assert from "node:assert/strict";
import test from "node:test";
import { scanText } from "../lib/release-check.mjs";

test("release scanner accepts ordinary public text", () => {
  assert.deepEqual(scanText("README.md", "public documentation\n"), []);
});

test("release scanner detects a private home path", () => {
  const value = "/" + "Users/private-owner/project";
  assert.match(scanText("file.txt", value)[0], /private macOS home path/);
});

test("release scanner detects common credential formats", () => {
  const value = "gh" + "o_" + "a".repeat(30);
  assert.match(scanText("file.txt", value)[0], /GitHub token/);
});
