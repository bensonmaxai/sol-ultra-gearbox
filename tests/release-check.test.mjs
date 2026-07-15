import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WORKFLOW_POLICY } from "../lib/gearbox.mjs";
import { REQUIRED_RELEASE_FILES, scanText } from "../lib/release-check.mjs";

const BUNDLED_SKILL = fileURLToPath(
  new URL("../skills/sol-ultra-gearbox/SKILL.md", import.meta.url),
);
const VERIFIED_WORKFLOWS = fileURLToPath(
  new URL("../skills/sol-ultra-gearbox/references/verified-workflows.md", import.meta.url),
);
const QUALITY_DISPATCH = fileURLToPath(
  new URL("../skills/sol-ultra-gearbox/references/quality-first-dispatch.md", import.meta.url),
);
const REPOSITORY_AGENTS = fileURLToPath(new URL("../AGENTS.md", import.meta.url));
const README = fileURLToPath(new URL("../README.md", import.meta.url));
const OPENAI_YAML = fileURLToPath(
  new URL("../skills/sol-ultra-gearbox/agents/openai.yaml", import.meta.url),
);
const DISPATCH_LEDGER_TEST = fileURLToPath(
  new URL("../tests/dispatch-ledger.test.mjs", import.meta.url),
);

test("release scanner accepts ordinary public text", () => {
  assert.deepEqual(scanText("README.md", "public documentation\n"), []);
});

test("release scanner detects a private home path", () => {
  const value = "/" + "Users/private-owner/project";
  assert.match(scanText("file.txt", value)[0], /private macOS home path/);
});

test("release candidate requirements include the quality-first dispatch reference", () => {
  assert.ok(
    REQUIRED_RELEASE_FILES.includes(
      "skills/sol-ultra-gearbox/references/quality-first-dispatch.md",
    ),
  );
  assert.ok(
    REQUIRED_RELEASE_FILES.includes(
      "skills/sol-ultra-gearbox/references/verified-workflows.md",
    ),
  );
  assert.ok(REQUIRED_RELEASE_FILES.includes("docs/workflow-contract-evidence.json"));
});

test("dispatch-ledger fixture constructs its private path without embedding it in release text", async () => {
  const source = await readFile(DISPATCH_LEDGER_TEST, "utf8");
  assert.deepEqual(scanText("tests/dispatch-ledger.test.mjs", source), []);
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
  assert.match(source, /superpowers:writing-skills/);
  assert.match(source, /sol_skill_tester/);
  assert.match(source, /five.*RED.*five.*GREEN|5.*RED.*5.*GREEN/i);
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
    assert.match(value, /executing-plans/);
    assert.match(value, /isolatedRunnerVerified/);
    assert.match(value, /fork N\/A/);
  }
  assert.match(source, /isolated root, never a child/i);
  assert.match(source, /references\/quality-first-dispatch\.md/);
});

test("managed policy, repository policy, and bundled skill publish the verified workflow contract", async () => {
  const [skill, reference, agents, readme, openaiYaml] = await Promise.all([
    readFile(BUNDLED_SKILL, "utf8"),
    readFile(VERIFIED_WORKFLOWS, "utf8"),
    readFile(REPOSITORY_AGENTS, "utf8"),
    readFile(README, "utf8"),
    readFile(OPENAI_YAML, "utf8"),
  ]);
  const concepts = [
    /validated.*DAG/i,
    /schema.*version 2/i,
    /reserved.*verification/i,
    /first real execution.*canary/i,
    /evidence.*verify.*adopt.*close/is,
    /upstream.*source of truth/i,
    /resume.*adopted/i,
    /root_inline.*typed_child.*isolated_role_root/is,
    /app_thread_root.*not enabled/i,
    /not.*Codex core hook/i,
  ];
  for (const value of [WORKFLOW_POLICY, skill, reference, agents]) {
    for (const concept of concepts) assert.match(value, concept);
  }
  assert.match(skill, /references\/verified-workflows\.md/);
  assert.match(readme, /verified workflow orchestration/i);
  assert.match(openaiYaml, /verified workflow/i);
  for (const value of [readme, openaiYaml]) {
    assert.doesNotMatch(
      value,
      /(?:claims?|promises?|guarantees?|delivers?)\s+(?:faster|[^.\n]{0,80}(?:speedup|savings|superior output))|app_thread_root provider/i,
    );
  }
});

test("public guidance distinguishes the executable App Server launcher from stock task interception", async () => {
  const [skill, dispatch, readme] = await Promise.all([
    readFile(BUNDLED_SKILL, "utf8"),
    readFile(QUALITY_DISPATCH, "utf8"),
    readFile(README, "utf8"),
  ]);
  for (const value of [WORKFLOW_POLICY, skill, dispatch, readme]) {
    assert.match(value, /app_server_root/i);
    assert.match(value, /gearbox-root/i);
    assert.match(value, /turn\/start/i);
    assert.match(value, /persisted.*model.*effort|persisted.*runtime/is);
    assert.match(value, /not.*(?:stock Desktop interception|Codex core hook)/i);
    assert.match(value, /app_thread_root.*(?:disabled|not enabled)/i);
  }
});
