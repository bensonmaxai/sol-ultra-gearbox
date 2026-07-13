import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scanText } from "../lib/release-check.mjs";

const BUNDLED_SKILL = fileURLToPath(
  new URL("../skills/sol-ultra-gearbox/SKILL.md", import.meta.url),
);

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

test("bundled skill documents Sol Max and the Terra Max opt-in role", async () => {
  const source = await readFile(BUNDLED_SKILL, "utf8");
  assert.match(source, /Sol\s+Max is a root execution mode/);
  assert.match(source, /`terra_max_worker` as an explicit opt-in compatibility role/);
  assert.match(source, /Never select it automatically/);
  assert.match(source, /references\/routing-matrix\.md/);
});
