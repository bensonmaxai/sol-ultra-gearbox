import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WORKFLOW_POLICY } from "../lib/gearbox.mjs";
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
  assert.match(source, /references\/subagent-skill-compatibility\.md/);
});

test("managed policy and bundled skill publish the quality-first dispatch contract", async () => {
  const source = await readFile(BUNDLED_SKILL, "utf8");
  for (const value of [WORKFLOW_POLICY, source]) {
    assert.match(value, /quality gate.*cost gate|quality.*before.*cost/i);
    assert.match(value, /gearbox-dispatch plan/);
    assert.match(value, /root_inline/);
    assert.match(value, /typed_child/);
    assert.match(value, /isolated_role_root/);
    assert.match(value, /typed_child_bridge/);
    assert.match(value, /allowTypedBridge=false/);
    assert.match(value, /ten-question acceptance/i);
    assert.match(value, /one correction/i);
    assert.match(value, /unsupported direct `spawn_agent` calls/i);
    assert.match(value, /not intercepted by this repository/i);
  }
  assert.match(source, /isolated root, never a child/i);
  assert.match(source, /references\/quality-first-dispatch\.md/);
});
