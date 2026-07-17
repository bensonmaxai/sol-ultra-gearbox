import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakeCodex } from "./helpers/fake-codex.mjs";
import { ROLE_SPECS, cleanupProbeArtifacts, sha256 } from "../lib/gearbox.mjs";
import { hashTaskPacket } from "../lib/dispatch-planner.mjs";
import { compileStagePacket } from "../lib/workflow-compiler.mjs";
import { hashWorkflowPlan } from "../lib/workflow-plan.mjs";
import { workflowPlan } from "./helpers/workflow-fixtures.mjs";
import {
  buildIsolatedRootArgs,
  parseRoleInstructions,
  renderIsolatedPrompt,
  runIsolatedRole,
} from "../lib/dispatch-runner.mjs";

const luna = ROLE_SPECS.find((role) => role.name === "luna_clerk");
const terra = ROLE_SPECS.find((role) => role.name === "terra_explorer");
const tester = ROLE_SPECS.find((role) => role.name === "sol_skill_tester");
const roleSource = `name = "luna_clerk"
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
sandbox_mode = "read-only"
developer_instructions = """
Read exactly one bounded task.
Never spawn, delegate to, or request another agent.
"""

[plugins."superpowers@openai-curated"]
enabled = false
`;
const task = "Inspect this fixture without edits.";
const marker = "ISOLATED_ROOT_OK";
const terraSource = roleSource
  .replace("luna_clerk", "terra_explorer")
  .replace("gpt-5.6-luna", "gpt-5.6-terra")
  .replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "medium"');
const testerSource = roleSource
  .replace("luna_clerk", "sol_skill_tester")
  .replace("gpt-5.6-luna", "gpt-5.6-sol")
  .replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "high"');
const receiveDeliverable = async (value) => value === '{"kind":"fake-deliverable","value":"verified"}';

test("isolated-root arguments use the selected cheap read role without parent delegation", () => {
  const instructions = parseRoleInstructions(roleSource);
  const args = buildIsolatedRootArgs({ roleSpec: luna, instructions, cwd: "/tmp/work", task, marker });
  assert.deepEqual(args.slice(0, -1), [
    "--strict-config",
    "-c", 'model="gpt-5.6-luna"',
    "-c", 'model_reasoning_effort="low"',
    "-c", 'plugins."superpowers@openai-curated".enabled=false',
    "-s", "read-only",
    "-a", "never",
    "-C", "/tmp/work",
    "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
  ]);
  assert.match(args.at(-1), /Task packet hash:/);
  assert.doesNotMatch(args.join("\n"), /spawn_agent|agent_type|fork_turns|gpt-5\.6-sol/i);
  assert.doesNotThrow(() => buildIsolatedRootArgs({ roleSpec: terra, instructions: parseRoleInstructions(terraSource), cwd: "/tmp/work", task, marker }));
});

test("role instruction parser requires exactly one complete multiline block", () => {
  assert.match(parseRoleInstructions(roleSource), /Read exactly one bounded task/);
  for (const source of [
    roleSource.replace('developer_instructions = """', "# developer_instructions = \"\"\""),
    roleSource.replace('"""\n\n[plugins', "\n\n[plugins"),
    `${roleSource}\ndeveloper_instructions = """\nduplicate\n"""\n`,
    `${roleSource}\ndeveloper_instructions = """\nunterminated\n`,
  ]) assert.throws(() => parseRoleInstructions(source), /developer_instructions/);
});

test("isolated runner rejects all non-cheap-read roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-reject-"));
  try {
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    for (const role of ROLE_SPECS.filter((candidate) => ![luna.name, terra.name, tester.name].includes(candidate.name))) {
      await assert.rejects(
        runIsolatedRole({ codexHome: root, roleSpec: role, roleSource, cwd: root, task, taskHash: sha256(task) }),
        /unsupported isolated root role/,
      );
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("isolated runner accepts the skill tester only for its exact workflow reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-skill-tester-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-skill-tester-work-"));
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    await assert.rejects(
      runIsolatedRole({
        codexBin: fake,
        codexHome: root,
        roleSpec: tester,
        roleSource: testerSource,
        cwd,
        task,
        taskHash: sha256(task),
        onDeliverable: receiveDeliverable,
      }),
      /unsupported isolated root role/,
    );
    const result = await runIsolatedRole({
      codexBin: fake,
      codexHome: root,
      roleSpec: tester,
      roleSource: testerSource,
      cwd,
      task,
      taskHash: sha256(task),
      reasonCode: "DELEGATE_ISOLATED_SKILL_PRESSURE_TEST",
      timeoutMs: 2_000,
      onDeliverable: receiveDeliverable,
    });
    assert.equal(result.pass, true);
    assert.equal(result.role, "sol_skill_tester");
    assert.equal(result.actual.model, "gpt-5.6-sol");
    assert.equal(result.actual.effort, "high");
    assert.equal(result.actual.depth, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("isolated runner accepts exact root evidence and removes temporary homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-success-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-work-"));
  const concurrentRunner = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-dispatch-sol_skill_tester-"));
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    let delivered = null;
    const cleanedPaths = [];
    const result = await runIsolatedRole({
      codexBin: fake,
      codexHome: root,
      roleSpec: luna,
      roleSource,
      cwd,
      task,
      taskHash: sha256(task),
      timeoutMs: 2_000,
      onDeliverable: async (value) => { delivered = value; return receiveDeliverable(value); },
      cleanupArtifacts: async (paths) => {
        cleanedPaths.push(...paths);
        return cleanupProbeArtifacts(paths);
      },
    });
    assert.equal(result.pass, true);
    assert.equal(delivered, '{"kind":"fake-deliverable","value":"verified"}');
    assert.doesNotMatch(JSON.stringify(result), /fake-deliverable|verified/);
    assert.equal(result.actual.parentTokens, 17);
    assert.equal(result.actual.depth, 0);
    assert.equal(cleanedPaths.length, 2);
    for (const path of cleanedPaths) await assert.rejects(lstat(path), /ENOENT/);
    assert.equal((await lstat(concurrentRunner)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(concurrentRunner, { recursive: true, force: true });
  }
});

test("isolated runner accepts a marker-framed deliverable longer than the generic summary cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-long-deliverable-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-long-deliverable-work-"));
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    let delivered = null;
    const result = await runIsolatedRole({
      codexBin: fake,
      codexHome: root,
      roleSpec: terra,
      roleSource: terraSource,
      cwd,
      task,
      taskHash: sha256(task),
      timeoutMs: 2_000,
      env: { FAKE_CODEX_MODE: "long_deliverable" },
      onDeliverable: async (value) => {
        delivered = value;
        return value === "x".repeat(5_000);
      },
    });
    assert.equal(result.pass, true);
    assert.equal(delivered?.length, 5_000);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("isolated runner passes task data as argv rather than a shell command", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-injection-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-injection-work-"));
  const target = join(cwd, "must-not-exist");
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    const injectedTask = `Inspect only; touch ${target}`;
    const result = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task: injectedTask, taskHash: sha256(injectedTask), timeoutMs: 2_000, onDeliverable: receiveDeliverable });
    assert.equal(result.pass, true);
    await assert.rejects(lstat(target), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

test("isolated runner serializes workflow task-packet v2 without weakening runtime checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-v2-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-v2-work-"));
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    const plan = workflowPlan();
    const taskPacket = compileStagePacket({
      plan,
      planHash: hashWorkflowPlan(plan),
      stageId: "audit-core",
      approvalFacts: [],
      batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
    });
    const result = await runIsolatedRole({
      codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd,
      taskPacket, taskHash: hashTaskPacket(taskPacket), timeoutMs: 2_000,
      onDeliverable: receiveDeliverable,
    });
    assert.equal(result.pass, true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

test("isolated runner fails closed for fake runtime evidence, delegation, timeout, marker, and writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-failures-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-failures-work-"));
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    await Promise.all([
      writeFile(join(cwd, "stable.txt"), "stable\n", "utf8"),
      writeFile(join(cwd, "deleted.txt"), "delete me\n", "utf8"),
      writeFile(join(cwd, "chmod.txt"), "mode\n", { encoding: "utf8", mode: 0o644 }),
    ]);
    for (const mode of [
      "model_mismatch",
      "effort_mismatch",
      "sandbox_mismatch",
      "source_mismatch",
      "source_missing",
      "token_missing",
      "timeout",
      "spawn",
      "filesystem_mutations",
      "two_roots",
      "malformed",
    ]) {
      const result = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task), timeoutMs: 40, env: { FAKE_CODEX_MODE: mode }, onDeliverable: receiveDeliverable });
      assert.equal(result.pass, false, mode);
      assert.equal(result.rollbackRequired, true, mode);
    }
  } finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

test("marker and consumer rejection are deliverable-only failures without rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-delivery-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-delivery-work-"));
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    const marker = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task), env: { FAKE_CODEX_MODE: "marker_mismatch" }, onDeliverable: receiveDeliverable });
    assert.equal(marker.pass, false);
    assert.equal(marker.rollbackRequired, false);
    let inlineDelivered = false;
    const inlineMarker = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task), env: { FAKE_CODEX_MODE: "marker_inline" }, onDeliverable: async () => { inlineDelivered = true; return true; } });
    assert.equal(inlineMarker.pass, false);
    assert.equal(inlineMarker.rollbackRequired, false);
    assert.equal(inlineDelivered, false);
    const rejected = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task), onDeliverable: async () => false });
    assert.equal(rejected.pass, false);
    assert.equal(rejected.rollbackRequired, false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

test("isolated runner exposes no deliverable until cleanup succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-cleanup-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-cleanup-work-"));
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    let delivered = false;
    const result = await runIsolatedRole({
      codexBin: fake,
      codexHome: root,
      roleSpec: luna,
      roleSource,
      cwd,
      task,
      taskHash: sha256(task),
      onDeliverable: async () => {
        delivered = true;
        return true;
      },
      cleanupArtifacts: async (paths) => {
        await cleanupProbeArtifacts(paths);
        throw new Error("synthetic cleanup failure after removal");
      },
    });
    assert.equal(result.pass, false);
    assert.equal(result.checks.cleanupPassed, false);
    assert.equal(result.rollbackRequired, true);
    assert.equal(delivered, false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

test("isolated runner refuses symlink workspaces and a missing or rejected consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-consumer-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-consumer-work-"));
  const link = join(root, "workspace-link");
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    await symlink(cwd, link);
    await assert.rejects(
      runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd: link, task, taskHash: sha256(task), onDeliverable: receiveDeliverable }),
      /physical directory/,
    );
    await assert.rejects(
      runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task) }),
      /onDeliverable/,
    );
    const rejected = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task), onDeliverable: async () => false });
    assert.equal(rejected.pass, false);
    assert.equal(rejected.rollbackRequired, false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

test("isolated runner drains large JSON output and force-kills a SIGTERM-resistant timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-lifecycle-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-lifecycle-work-"));
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    const large = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task), timeoutMs: 2_000, env: { FAKE_CODEX_MODE: "pipe_output" }, onDeliverable: receiveDeliverable });
    assert.equal(large.pass, true);
    const started = Date.now();
    const timeout = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task), timeoutMs: 40, env: { FAKE_CODEX_MODE: "timeout" }, onDeliverable: receiveDeliverable });
    assert.equal(timeout.pass, false);
    assert.equal(timeout.checks.commandDidNotTimeout, false);
    assert.ok(Date.now() - started < 1_000);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});
