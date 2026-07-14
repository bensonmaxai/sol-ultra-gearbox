import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_ROOT_EFFORTS,
  AGENTS_MARKER,
  CONFIG_LEGACY_THREADS_MARKER,
  CONFIG_ROLE_SPECS,
  CONFIG_ROLES_MARKER,
  CONFIG_V2_MARKER,
  MAX_DIRECT_CHILDREN,
  MULTI_AGENT_SESSION_THREADS,
  ROLE_SPECS,
  TYPED_ROLE_NAMES,
  WORKFLOW_POLICY,
  atomicWrite,
  captureConfigRollbackState,
  cleanupProbeArtifacts,
  DISPATCH_RUNTIME_FILES,
  RUNTIME_BINDING_FILES,
  WORKFLOW_CONTRACT_SOURCE_PATHS,
  installDispatchRuntime,
  readCurrentWorkflowContractEvidence,
  rollbackDispatchRuntime,
  redactSensitive,
  removeOwnedSmokeProjectEntries,
  renderAgentsMd,
  renderConfig,
  rollbackConfig,
  restoreConfigRollbackState,
  sha256,
  summarizeRollout,
  validateTypedSpawnArgs,
  validatePostInstallRootRuntime,
  validateRoleText,
  verifyProbe,
  writeJson,
} from "../lib/gearbox.mjs";
import { createDispatchPolicy, serializeDispatchPolicy } from "../lib/dispatch-policy.mjs";
import { WORKFLOW_CONTRACT_SOURCE_PATHS as EVIDENCE_SOURCE_PATHS } from "../lib/workflow-contract-evidence.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const WORKFLOW_RUNTIME_FILES = [
  "lib/workflow-plan.mjs",
  "lib/workflow-compiler.mjs",
  "lib/workflow-state.mjs",
  "lib/workflow-scheduler.mjs",
  "lib/workflow-orchestrator.mjs",
  "lib/private-jsonl.mjs",
  "lib/workflow-ledger.mjs",
  "lib/workflow-recovery.mjs",
  "lib/workflow-outcome.mjs",
  "lib/owned-packet.mjs",
  "lib/workflow-cli.mjs",
];

const RUNTIME_BINDING_ONLY_FILES = [
  "lib/workflow-contract-evidence.mjs",
  "scripts/workflow-contract-evidence.mjs",
  "docs/workflow-contract-evidence.json",
];

function relativeImports(source) {
  return [...source.matchAll(
    /\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["'](\.[^"']+)["']/g,
  )].map((match) => match[1]);
}

const CONFIG_FIXTURE = `model = "gpt-5.6-sol"
model_reasoning_effort = "max"

[agents]
max_threads = 3
max_depth = 1

[agents.terra_max_worker]
description = "Legacy role"
config_file = "/home/test/.codex/agents/terra-max-worker.toml"

[agents.terra_ultra_specialist]
description = "Ultra role"
config_file = "/home/test/.codex/agents/terra-ultra-specialist.toml"

[mcp_servers.example]
command = "example"
secret_value = "SECRET_KEEP"
`;

async function treeState(root) {
  const entries = {};
  async function visit(path) {
    const metadata = await lstat(path);
    const relativePath = path === root ? "." : path.slice(root.length + 1);
    entries[relativePath] = {
      type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
      mode: metadata.mode & 0o777,
      sha256: metadata.isFile() ? sha256(await readFile(path)) : null,
    };
    if (metadata.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    }
  }
  await visit(root);
  return entries;
}

test("renderConfig adds only marker-delimited role and v2 blocks", () => {
  const output = renderConfig(CONFIG_FIXTURE, "/home/test/.codex");
  assert.match(output, new RegExp(CONFIG_ROLES_MARKER));
  assert.match(output, new RegExp(CONFIG_V2_MARKER));
  assert.match(output, /^\[agents\.luna_clerk\]$/m);
  assert.match(output, /^\[agents\.terra_worker\]$/m);
  assert.doesNotMatch(output, /^\[agents\.sol_skill_tester\]$/m);
  assert.match(output, /^\[features\.multi_agent_v2\]$/m);
  assert.equal(MAX_DIRECT_CHILDREN, 2);
  assert.equal(MULTI_AGENT_SESSION_THREADS, MAX_DIRECT_CHILDREN + 1);
  assert.match(output, /^max_concurrent_threads_per_session = 3$/m);
  assert.match(output, /^tool_namespace = "agents"$/m);
  assert.match(output, new RegExp(CONFIG_LEGACY_THREADS_MARKER));
  assert.doesNotMatch(output, /^max_threads\s*=/m);
  assert.equal(output.match(/SECRET_KEEP/g)?.length, 1);
  assert.equal(output.match(/^\[agents\.terra_max_worker\]$/gm)?.length, 1);
  assert.equal(
    output.match(/^\[agents\.terra_ultra_specialist\]$/gm)?.length,
    1,
  );
});

test("renderConfig is idempotent", () => {
  const once = renderConfig(CONFIG_FIXTURE, "/home/test/.codex");
  const twice = renderConfig(once, "/home/test/.codex");
  assert.equal(twice, once);
});

test("rollbackConfig removes only Gearbox-managed config", () => {
  const installed = renderConfig(CONFIG_FIXTURE, "/home/test/.codex");
  const rolledBack = rollbackConfig(installed);
  assert.equal(rolledBack, CONFIG_FIXTURE);
  assert.match(rolledBack, /SECRET_KEEP/);
  assert.doesNotMatch(rolledBack, new RegExp(CONFIG_ROLES_MARKER));
  assert.doesNotMatch(rolledBack, new RegExp(CONFIG_V2_MARKER));
  assert.doesNotMatch(rolledBack, new RegExp(CONFIG_LEGACY_THREADS_MARKER));
});

test("managed rollback state restores a previous Gearbox config byte for byte", () => {
  const previous = renderConfig(CONFIG_FIXTURE, "/home/test/.codex")
    .replace(
      "max_concurrent_threads_per_session = 3",
      "max_concurrent_threads_per_session = 2",
    );
  const rollbackState = captureConfigRollbackState(previous);
  assert.doesNotMatch(JSON.stringify(rollbackState), /SECRET_KEEP/);
  const installed = renderConfig(previous, "/home/test/.codex");
  const restored = restoreConfigRollbackState(installed, {
    rollbackState,
    expectedSha256: sha256(previous),
    codexHome: "/home/test/.codex",
  });
  assert.equal(restored.strategy, "managed_state");
  assert.equal(restored.source, previous);
});

test("forced managed rollback preserves unrelated post-install config drift", () => {
  const rollbackState = captureConfigRollbackState(CONFIG_FIXTURE);
  const installed = renderConfig(CONFIG_FIXTURE, "/home/test/.codex");
  const drifted = `${installed.trimEnd()}\n\n[unrelated]\nkeep = true\n`;
  const restored = restoreConfigRollbackState(drifted, {
    rollbackState,
    expectedSha256: sha256(CONFIG_FIXTURE),
    codexHome: "/home/test/.codex",
    allowHashMismatch: true,
  });
  assert.equal(restored.strategy, "managed_state");
  assert.equal(restored.exact, false);
  assert.match(restored.source, /^\[unrelated\]$/m);
  assert.match(restored.source, /^keep = true$/m);
  assert.match(restored.source, /SECRET_KEEP/);
  assert.doesNotMatch(restored.source, new RegExp(CONFIG_V2_MARKER));
});

test("legacy failed rollback reconstructs the previous two-slot managed config by hash", () => {
  const previous = renderConfig(CONFIG_FIXTURE, "/home/test/.codex")
    .replace(
      "max_concurrent_threads_per_session = 3",
      "max_concurrent_threads_per_session = 2",
    );
  const stripped = rollbackConfig(renderConfig(previous, "/home/test/.codex"));
  const restored = restoreConfigRollbackState(stripped, {
    rollbackState: null,
    expectedSha256: sha256(previous),
    codexHome: "/home/test/.codex",
  });
  assert.equal(restored.strategy, "legacy_v2_hash_match");
  assert.equal(restored.source, previous);
  assert.throws(
    () => restoreConfigRollbackState(stripped, {
      rollbackState: null,
      expectedSha256: "0".repeat(64),
      codexHome: "/home/test/.codex",
    }),
    /expected pre-install config hash/,
  );
});

test("post-install root runtime accepts persisted Sol Max or Ultra only in active mode", () => {
  assert.deepEqual(ACTIVE_ROOT_EFFORTS, ["max", "ultra"]);
  for (const effort of ACTIVE_ROOT_EFFORTS) {
    assert.equal(validatePostInstallRootRuntime({
      persisted: true,
      model: "gpt-5.6-sol",
      effort,
    }, { active: true }).pass, true);
  }
  assert.equal(validatePostInstallRootRuntime({
    persisted: true,
    model: "gpt-5.6-sol",
    effort: "high",
  }, { active: true }).pass, false);
  assert.equal(validatePostInstallRootRuntime({
    persisted: true,
    model: "gpt-5.6-terra",
    effort: "ultra",
  }, { active: true }).pass, false);
  assert.equal(validatePostInstallRootRuntime({
    persisted: false,
    model: "gpt-5.6-sol",
    effort: "ultra",
  }, { active: true }).pass, false);
});

test("renderConfig refuses an unmanaged multi_agent_v2 table", () => {
  const input = `${CONFIG_FIXTURE}\n[features.multi_agent_v2]\nenabled = true\n`;
  assert.throws(
    () => renderConfig(input, "/home/test/.codex"),
    /unmanaged \[features\.multi_agent_v2\]/,
  );
});

test("renderConfig preserves any positive legacy max_threads value", () => {
  const input = CONFIG_FIXTURE.replace("max_threads = 3", "max_threads = 6");
  const installed = renderConfig(input, "/home/test/.codex");
  assert.match(installed, /# original: max_threads = 6/);
  assert.doesNotMatch(installed, /^max_threads\s*=/m);
  assert.equal(rollbackConfig(installed), input);
});

test("renderConfig supports an agents table without legacy max_threads", () => {
  const input = CONFIG_FIXTURE.replace("max_threads = 3\n", "");
  const installed = renderConfig(input, "/home/test/.codex");
  assert.doesNotMatch(installed, new RegExp(CONFIG_LEGACY_THREADS_MARKER));
  assert.equal(rollbackConfig(installed), input);
});

test("renderConfig refuses an invalid legacy max_threads value", () => {
  assert.throws(
    () =>
      renderConfig(
        CONFIG_FIXTURE.replace("max_threads = 3", 'max_threads = "many"'),
        "/home/test/.codex",
      ),
    /positive integer/,
  );
});

test("removeOwnedSmokeProjectEntries removes only Gearbox temp trust entries", () => {
  const input = `[projects."/home/test/repo"]
trust_level = "trusted"

[projects."/private/var/folders/aa/T/sol-ultra-gearbox-v2-terra_worker-Ab12"]
trust_level = "trusted"

[projects."/private/var/folders/aa/T/unrelated-worker-Ab12"]
trust_level = "trusted"

[desktop]
enabled = true
`;
  const result = removeOwnedSmokeProjectEntries(input);
  assert.deepEqual(result.paths, [
    "/private/var/folders/aa/T/sol-ultra-gearbox-v2-terra_worker-Ab12",
  ]);
  assert.doesNotMatch(result.source, /sol-ultra-gearbox-v2-terra_worker/);
  assert.match(result.source, /unrelated-worker-Ab12/);
  assert.match(result.source, /\[projects\."\/home\/test\/repo"\]/);
  assert.match(result.source, /\[desktop\]/);
});

test("renderAgentsMd replaces the workflow section and preserves neighbors", () => {
  const input = `# Global\n\nBefore.\n\n## Workflow and Delegation Budget\n- old rule\n\n### User Trigger Routing\n- old trigger\n\n## Later Section\n\nKeep me.\n`;
  const output = renderAgentsMd(input);
  assert.match(output, new RegExp(AGENTS_MARKER));
  assert.match(output, /luna_clerk/);
  assert.match(output, /Sol Max/);
  assert.match(output, /terra_max_worker/);
  assert.match(output, /## Later Section\n\nKeep me\./);
  assert.doesNotMatch(output, /old rule|old trigger/);
  assert.equal(renderAgentsMd(output), output);
});

test("managed policy gates skill-driven delegation and unknown skills", () => {
  assert.match(WORKFLOW_POLICY, /Skill-driven Delegation Compatibility Gate/);
  assert.match(WORKFLOW_POLICY, /pre-spawn compatibility gate/);
  assert.match(WORKFLOW_POLICY, /executing-plans/);
  assert.match(WORKFLOW_POLICY, /subagent-driven-development/);
  assert.match(WORKFLOW_POLICY, /dispatching-parallel-agents/);
  assert.match(WORKFLOW_POLICY, /requesting-code-review/);
  assert.match(WORKFLOW_POLICY, /security-scan/);
  assert.match(WORKFLOW_POLICY, /security-diff-scan/);
  assert.match(WORKFLOW_POLICY, /superpowers:writing-skills/);
  assert.match(WORKFLOW_POLICY, /sol_skill_tester/);
  assert.match(WORKFLOW_POLICY, /at least five|至少五/i);
  assert.match(WORKFLOW_POLICY, /fresh isolated|全新隔離/i);
  assert.match(WORKFLOW_POLICY, /expected verdict|預期判定/i);
  assert.match(WORKFLOW_POLICY, /owner approval|owner.*批准/i);
  assert.match(WORKFLOW_POLICY, /sites:sites-building/);
  assert.match(WORKFLOW_POLICY, /hatch-pet/);
  assert.match(WORKFLOW_POLICY, /heygen:heygen-video/);
  assert.match(WORKFLOW_POLICY, /unknown skill/i);
  assert.match(WORKFLOW_POLICY, /fail closed/i);
  assert.match(WORKFLOW_POLICY, /general-purpose/);
  assert.match(WORKFLOW_POLICY, /不得.*靜默.*改寫/);
  assert.match(WORKFLOW_POLICY, /非-Ultra root 下依序建立單一 typed child/);
  assert.match(WORKFLOW_POLICY, /parent permission.*read-only/);
  assert.match(WORKFLOW_POLICY, /Sol root 自行 task review/);
  assert.match(WORKFLOW_POLICY, /isolatedRunnerVerified/);
  assert.match(WORKFLOW_POLICY, /isolated.*不需要.*agent_type/i);
  assert.match(WORKFLOW_POLICY, /沒有.*child.*fork N\/A/i);
});

test("typed spawn validation rejects generic, untyped, and overridden children", () => {
  const valid = {
    agent_type: "terra_worker",
    fork_turns: "none",
    message: "bounded task",
  };
  assert.equal(validateTypedSpawnArgs(valid).pass, true);

  for (const agentType of [undefined, "default", "general-purpose", "worker"]) {
    const args = { ...valid };
    if (agentType === undefined) delete args.agent_type;
    else args.agent_type = agentType;
    const result = validateTypedSpawnArgs(args);
    assert.equal(result.pass, false, `agent_type=${agentType}`);
    assert.equal(result.checks.knownTypedRole, false);
  }

  for (const override of [
    { fork_turns: "all" },
    { model: "gpt-5.6-terra" },
    { reasoning_effort: "high" },
    { model_reasoning_effort: "high" },
    { service_tier: "priority" },
    { message: "   " },
  ]) {
    assert.equal(validateTypedSpawnArgs({ ...valid, ...override }).pass, false);
  }
});

test("all checked-in role files match their role specs", async () => {
  for (const spec of ROLE_SPECS) {
    const source = await readFile(join(REPO_ROOT, "roles", spec.sourceFile), "utf8");
    const result = validateRoleText(spec, source);
    assert.equal(result.pass, true, `${spec.name}: ${JSON.stringify(result.checks)}`);
  }
});

test("all six published roles participate in live smoke", () => {
  assert.deepEqual(
    ROLE_SPECS.filter((role) => role.smoke).map((role) => role.name),
    [
      "luna_clerk",
      "terra_explorer",
      "terra_worker",
      "sol_reviewer",
      "terra_ultra_specialist",
      "terra_max_worker",
    ],
  );
});

test("skill pressure tester is installed but never exposed as a typed child", () => {
  const tester = ROLE_SPECS.find((role) => role.name === "sol_skill_tester");
  assert.deepEqual(
    {
      model: tester?.model,
      effort: tester?.effort,
      sandbox: tester?.sandbox,
      smoke: tester?.smoke,
      isolatedOnly: tester?.isolatedOnly,
    },
    {
      model: "gpt-5.6-sol",
      effort: "high",
      sandbox: "read-only",
      smoke: false,
      isolatedOnly: true,
    },
  );
  assert.equal(TYPED_ROLE_NAMES.includes("sol_skill_tester"), false);
  assert.equal(CONFIG_ROLE_SPECS.some((role) => role.name === "sol_skill_tester"), false);
  assert.equal(validateTypedSpawnArgs({
    agent_type: "sol_skill_tester",
    fork_turns: "none",
    message: "pressure test",
  }).pass, false);
});

test("managed dispatch runtime is bound into the installer and packaged with the exact wrapper", async () => {
  const installer = await readFile(join(REPO_ROOT, "scripts", "gearbox.mjs"), "utf8");
  const wrapper = await readFile(join(REPO_ROOT, "scripts", "gearbox-dispatch"), "utf8");
  const wrapperMode = (await stat(join(REPO_ROOT, "scripts", "gearbox-dispatch"))).mode & 0o777;
  assert.match(installer, /DISPATCH_RUNTIME_FILES/);
  assert.match(installer, /scripts\/gearbox-dispatch/);
  assert.match(installer, /dispatchMode/);
  assert.match(installer, /randomBytes/);
  assert.doesNotMatch(installer, /GEARBOX_SKILL_GUIDANCE_7F3C9A/);
  assert.equal(wrapperMode, 0o755);
  assert.equal(
    wrapper,
    "#!/usr/bin/env bash\nset -euo pipefail\nCODEX_HOME_DIR=\"${CODEX_HOME:-${HOME}/.codex}\"\nexec node \"$CODEX_HOME_DIR/gearbox/runtime/scripts/gearbox-dispatch.mjs\" \"$@\"\n",
  );
});

test("all runtime evidence collectors use the one exact unique source inventory", async () => {
  assert.deepEqual(RUNTIME_BINDING_FILES, [
    "lib/gearbox.mjs",
    "lib/runtime-evidence.mjs",
    "lib/acceptance-exam.mjs",
    "scripts/gearbox.mjs",
    "scripts/codex-typed-agent",
    ...DISPATCH_RUNTIME_FILES,
    "lib/workflow-contract-evidence.mjs",
    "scripts/workflow-contract-evidence.mjs",
    "docs/workflow-contract-evidence.json",
    "scripts/gearbox-dispatch",
  ].filter((path, index, paths) => paths.indexOf(path) === index));
  const [gearboxScript, releaseEvidenceScript] = await Promise.all([
    readFile(join(REPO_ROOT, "scripts", "gearbox.mjs"), "utf8"),
    readFile(join(REPO_ROOT, "scripts", "release-evidence.mjs"), "utf8"),
  ]);
  for (const source of [gearboxScript, releaseEvidenceScript]) {
    assert.match(source, /RUNTIME_BINDING_FILES/);
    assert.doesNotMatch(source, /const RUNTIME_BINDING_PATHS/);
  }
});

test("workflow runtime inventory installs every CLI dependency and binds only deterministic evidence inputs", async () => {
  for (const path of WORKFLOW_RUNTIME_FILES) {
    assert.ok(DISPATCH_RUNTIME_FILES.includes(path), path);
    assert.ok(RUNTIME_BINDING_FILES.includes(path), path);
    assert.ok(
      DISPATCH_RUNTIME_FILES.indexOf(path) <
        DISPATCH_RUNTIME_FILES.indexOf("scripts/gearbox-dispatch.mjs"),
      `${path} must precede the installed CLI`,
    );
  }
  for (const path of RUNTIME_BINDING_ONLY_FILES) {
    assert.ok(RUNTIME_BINDING_FILES.includes(path), path);
    assert.equal(DISPATCH_RUNTIME_FILES.includes(path), false, path);
  }
  assert.equal(new Set(DISPATCH_RUNTIME_FILES).size, DISPATCH_RUNTIME_FILES.length);
  assert.equal(new Set(RUNTIME_BINDING_FILES).size, RUNTIME_BINDING_FILES.length);
});

test("the active workflow contract is exact, current, and shared with its deterministic generator", async () => {
  assert.deepEqual(WORKFLOW_CONTRACT_SOURCE_PATHS, EVIDENCE_SOURCE_PATHS);
  const current = await readCurrentWorkflowContractEvidence(REPO_ROOT);
  assert.match(current.sha256, /^[a-f0-9]{64}$/);
  assert.equal(current.evidence.scenarioCount, 5);
  assert.equal(current.evidence.passedScenarioCount, 5);
});

test("the active workflow contract rejects symlinked source and evidence parents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gearbox-workflow-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["lib", "tests", "docs"]) {
    await symlink(join(REPO_ROOT, directory), join(root, directory), "dir");
  }
  await assert.rejects(
    readCurrentWorkflowContractEvidence(root),
    /regular non-symlink repository file/i,
  );
});

test("installed dispatch runtime has a complete relative-import closure", async () => {
  const installed = new Set(DISPATCH_RUNTIME_FILES);
  const pending = ["scripts/gearbox-dispatch.mjs", ...DISPATCH_RUNTIME_FILES];
  const visited = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(join(REPO_ROOT, path), "utf8");
    for (const specifier of relativeImports(source)) {
      const imported = relative(REPO_ROOT, resolve(dirname(join(REPO_ROOT, path)), specifier));
      if (imported.startsWith("..")) continue;
      assert.ok(installed.has(imported), `${path} imports missing runtime module ${imported}`);
      pending.push(imported);
    }
  }
});

test("dispatch runtime install reads back exact targets and rollback restores a temporary CODEX_HOME", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gearbox-dispatch-install-"));
  const backups = await mkdtemp(join(tmpdir(), "gearbox-dispatch-backups-"));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(backups, { recursive: true, force: true })]));
  const policy = serializeDispatchPolicy(createDispatchPolicy({ mode: "shadow", allowTypedBridge: false, activation: null }));
  await mkdir(join(home, "gearbox", "runtime", "lib"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, "bin"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, "gearbox", "dispatch-policy.json"), policy, { mode: 0o640 });
  await writeFile(join(home, "gearbox", "runtime", "lib", "dispatch-planner.mjs"), "old runtime\n", { mode: 0o640 });
  await writeFile(join(home, "bin", "gearbox-dispatch"), "old wrapper\n", { mode: 0o700 });
  const before = await treeState(home);
  const manifest = await installDispatchRuntime({
    sourceRoot: REPO_ROOT,
    codexHome: home,
    backupDirectory: backups,
    dispatchMode: "shadow",
  });
  assert.equal(manifest.policyMode, "shadow");
  assert.equal(manifest.files.length, DISPATCH_RUNTIME_FILES.length + 2);
  for (const entry of manifest.files) {
    const metadata = await stat(entry.targetPath);
    assert.equal(metadata.mode & 0o777, entry.mode);
    assert.equal(sha256(await readFile(entry.targetPath)), entry.targetSha256);
    assert.equal(entry.sourceSha256, entry.targetSha256);
  }
  const runtime = manifest.files.filter((entry) => entry.kind === "dispatch-runtime");
  assert.equal(runtime.length, DISPATCH_RUNTIME_FILES.length);
  assert.ok(runtime.every((entry) => entry.mode === 0o644));
  assert.equal(manifest.files.find((entry) => entry.kind === "dispatch-wrapper").mode, 0o755);
  assert.equal(manifest.files.find((entry) => entry.kind === "dispatch-policy").mode, 0o600);

  await chmod(runtime[0].targetPath, 0o600);
  await assert.rejects(rollbackDispatchRuntime({ manifest }), /mode drift/);
  await chmod(runtime[0].targetPath, 0o644);
  await writeFile(runtime[0].targetPath, "content drift\n");
  await assert.rejects(rollbackDispatchRuntime({ manifest }), /content drift/);
  await rollbackDispatchRuntime({ manifest, force: true });
  assert.deepEqual(await treeState(home), before);
});

test("dispatch runtime install rolls back every target after a mid-write failure", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gearbox-dispatch-transaction-"));
  const backups = await mkdtemp(join(tmpdir(), "gearbox-dispatch-transaction-backups-"));
  t.after(() => Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(backups, { recursive: true, force: true }),
  ]));
  const before = await treeState(home);
  let writes = 0;
  const writtenPaths = [];
  const failureAt = DISPATCH_RUNTIME_FILES.length + 2;
  await assert.rejects(
    installDispatchRuntime({
      sourceRoot: REPO_ROOT,
      codexHome: home,
      backupDirectory: backups,
      dispatchMode: "shadow",
      writeTarget: async (...args) => {
        writes += 1;
        if (writes === failureAt) throw new Error("synthetic dispatch write failure");
        writtenPaths.push(args[0]);
        return atomicWrite(...args);
      },
    }),
    /synthetic dispatch write failure/,
  );
  assert.equal(writes, failureAt);
  for (const path of WORKFLOW_RUNTIME_FILES) {
    assert.ok(writtenPaths.includes(join(home, "gearbox", "runtime", path)), path);
  }
  assert.deepEqual(await treeState(home), before);
});

test("active dispatch install requires a hash-bound activation policy and remains rollback-safe", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gearbox-dispatch-active-"));
  const backups = await mkdtemp(join(tmpdir(), "gearbox-dispatch-active-backups-"));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(backups, { recursive: true, force: true })]));
  const activation = { installId: "install-test", manifestPath: "/private/tmp/active-manifest.json" };
  const policy = createDispatchPolicy({ mode: "active", allowTypedBridge: false, activation });
  const manifest = await installDispatchRuntime({
    sourceRoot: REPO_ROOT,
    codexHome: home,
    backupDirectory: backups,
    dispatchMode: "active",
    dispatchPolicy: policy,
  });
  assert.equal(manifest.policyMode, "active");
  const installed = JSON.parse(await readFile(join(home, "gearbox", "dispatch-policy.json"), "utf8"));
  assert.deepEqual(installed.activation, activation);
  assert.equal(installed.allowTypedBridge, false);
  await rollbackDispatchRuntime({ manifest, force: true });
});

test("redactSensitive removes sensitive payloads but retains usage counts", () => {
  const output = redactSensitive({
    token: "SECRET_TOKEN",
    auth: { bearer: "SECRET_AUTH" },
    stdout: "raw conversation",
    inputTokens: 123,
    nested: { cookie: "SECRET_COOKIE", total_tokens: 456 },
  });
  assert.equal(output.token, "[REDACTED]");
  assert.equal(output.auth, "[REDACTED]");
  assert.equal(output.stdout, "[REDACTED]");
  assert.equal(output.inputTokens, 123);
  assert.equal(output.nested.cookie, "[REDACTED]");
  assert.equal(output.nested.total_tokens, 456);
  assert.doesNotMatch(JSON.stringify(output), /SECRET_/);
});

test("rollout summary keeps session correlation in memory but writeJson removes raw rollout content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gearbox-rollout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  const report = join(directory, "report.json");
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "session-secret", thread_source: "root" },
      }),
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.6-terra", prompt: "raw prompt" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "raw rollout content" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { total_tokens: 7 } } },
      }),
    ].join("\n"),
    "utf8",
  );
  const summary = await summarizeRollout(rollout);
  assert.equal(summary.threadSource, "root");
  assert.equal(summary.sessionId, "session-secret");
  await writeJson(report, summary);
  const persisted = await readFile(report, "utf8");
  assert.doesNotMatch(persisted, /session-secret|raw prompt|raw rollout content/);
  assert.match(persisted, /total_tokens/);
});

test("rollout summary correlates a privacy-safe tool timeline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gearbox-rollout-timeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, "rollout.jsonl");
  await writeFile(rollout, [
    JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "private-luna", name: "spawn_agent", arguments: '{"agent_type":"luna_clerk","message":"private"}' } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "private-luna", output: '{"task":"private"}' } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "private-list", name: "agents.list_agents", arguments: '{}' } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "private-list", output: '{"agents":[{"agent_name":"private","agent_status":"running"}]}' } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "private-completed", name: "list_agents", arguments: '{}' } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "private-completed", output: '{"agents":[{"agent_status":{"completed":"private result"}}]}' } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "private-missing", name: "list_agents", arguments: '{}' } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "uncorrelated", output: '{"agents":[{"agent_status":"running"}]}' } }),
  ].join("\n"), "utf8");
  const summary = await summarizeRollout(rollout);
  assert.deepEqual(summary.toolTimeline, [
    { name: "spawn_agent", callIndex: 0, outputPresent: true, outputSha256: sha256('{"task":"private"}'), runningOrCompleted: false },
    { name: "agents.list_agents", callIndex: 1, outputPresent: true, outputSha256: sha256('{"agents":[{"agent_name":"private","agent_status":"running"}]}'), runningOrCompleted: true },
    { name: "list_agents", callIndex: 2, outputPresent: true, outputSha256: sha256('{"agents":[{"agent_status":{"completed":"private result"}}]}'), runningOrCompleted: true },
    { name: "list_agents", callIndex: 3, outputPresent: false, outputSha256: null, runningOrCompleted: false },
  ]);
  assert.doesNotMatch(JSON.stringify(summary.toolTimeline), /private-luna|private-list|luna_clerk|private/);
});

test("cleanupProbeArtifacts removes only owned temporary directories", async (t) => {
  const owned = await Promise.all([
    mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-luna_clerk-")),
    mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-terra_max_worker-")),
    mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-sdd-")),
    mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-dispatch-luna_clerk-")),
    mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-dispatch-home-terra_explorer-")),
  ]);
  const unrelated = await Promise.all([
    mkdtemp(join(tmpdir(), "unrelated-probe-")),
    mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-dispatch-terra_worker-")),
  ]);
  t.after(() => Promise.all(unrelated.map((path) => rm(path, { recursive: true, force: true }))));
  await Promise.all(
    owned.map((path) =>
      writeFile(join(path, "evidence.txt"), "temporary\n", "utf8"),
    ),
  );

  const result = await cleanupProbeArtifacts(owned);
  assert.equal(result.removed.length, 5);
  for (const path of owned) await assert.rejects(stat(path), /ENOENT/);
  await assert.rejects(
    cleanupProbeArtifacts([unrelated[0]]),
    /Refusing to remove non-Gearbox probe path/,
  );
  await assert.rejects(
    cleanupProbeArtifacts([unrelated[1]]),
    /Refusing to remove non-Gearbox probe path/,
  );
  assert.equal((await stat(unrelated[0])).isDirectory(), true);
  assert.equal((await stat(unrelated[1])).isDirectory(), true);
});

test("verifyProbe requires typed lineage, exact runtime settings, and no descendants", () => {
  const spec = ROLE_SPECS.find((role) => role.name === "terra_worker");
  const parent = {
    sessionMeta: { id: "parent" },
    turnContext: { model: "gpt-5.6-sol", effort: "max" },
    tokenUsage: { total_tokens: 200 },
    functionCalls: [
      {
        name: "spawn_agent",
        args: {
          agent_type: "terra_worker",
          task_name: "probe",
          fork_turns: "none",
          message: "encrypted",
        },
      },
    ],
  };
  const child = {
    sessionMeta: {
      agent_role: "terra_worker",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent",
            agent_role: "terra_worker",
            depth: 1,
          },
        },
      },
    },
    turnContext: {
      model: "gpt-5.6-terra",
      effort: "high",
      sandbox_policy: { type: "workspace-write" },
    },
    functionCalls: [],
    finalTexts: ["ROLE_PROBE_OK:terra_worker"],
    tokenUsage: { total_tokens: 100 },
  };
  const result = verifyProbe({
    spec,
    parent,
    child,
    marker: "ROLE_PROBE_OK:terra_worker",
    parentExpected: { model: "gpt-5.6-sol", effort: "max" },
  });
  assert.equal(result.pass, true);
  assert.equal(result.checks.parentModelMatches, true);
  assert.equal(result.checks.parentEffortMatches, true);
  assert.equal(result.checks.parentTokenUsagePersisted, true);
  assert.equal(result.checks.taskMessagePresent, true);

  const wrongParentEffort = verifyProbe({
    spec,
    parent: {
      ...parent,
      turnContext: { ...parent.turnContext, effort: "high" },
    },
    child,
    marker: "ROLE_PROBE_OK:terra_worker",
    parentExpected: { model: "gpt-5.6-sol", effort: "max" },
  });
  assert.equal(wrongParentEffort.pass, false);
  assert.equal(wrongParentEffort.checks.parentEffortMatches, false);

  const missingParentUsage = verifyProbe({
    spec,
    parent: { ...parent, tokenUsage: null },
    child,
    marker: "ROLE_PROBE_OK:terra_worker",
    parentExpected: { model: "gpt-5.6-sol", effort: "max" },
  });
  assert.equal(missingParentUsage.pass, false);
  assert.equal(missingParentUsage.checks.parentTokenUsagePersisted, false);

  const untyped = verifyProbe({
    spec,
    parent: {
      ...parent,
      functionCalls: [
        { name: "spawn_agent", args: { fork_turns: "none", message: "x" } },
      ],
    },
    child,
    marker: "ROLE_PROBE_OK:terra_worker",
    parentExpected: { model: "gpt-5.6-sol", effort: "max" },
  });
  assert.equal(untyped.pass, false);
  assert.equal(untyped.checks.typedRoleRequested, false);

  const missingTaskMessage = verifyProbe({
    spec,
    parent: {
      ...parent,
      functionCalls: [
        {
          name: "spawn_agent",
          args: { agent_type: "terra_worker", fork_turns: "none" },
        },
      ],
    },
    child,
    marker: "ROLE_PROBE_OK:terra_worker",
    parentExpected: { model: "gpt-5.6-sol", effort: "max" },
  });
  assert.equal(missingTaskMessage.pass, false);
  assert.equal(missingTaskMessage.checks.taskMessagePresent, false);

  const generic = verifyProbe({
    spec,
    parent: {
      ...parent,
      functionCalls: [
        {
          name: "spawn_agent",
          args: {
            agent_type: "general-purpose",
            fork_turns: "none",
            message: "x",
          },
        },
      ],
    },
    child,
    marker: "ROLE_PROBE_OK:terra_worker",
    parentExpected: { model: "gpt-5.6-sol", effort: "max" },
  });
  assert.equal(generic.pass, false);
  assert.equal(generic.checks.typedRoleRequested, false);
});
