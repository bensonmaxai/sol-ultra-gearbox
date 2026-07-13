import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENTS_MARKER,
  CONFIG_LEGACY_THREADS_MARKER,
  CONFIG_ROLES_MARKER,
  CONFIG_V2_MARKER,
  ROLE_SPECS,
  WORKFLOW_POLICY,
  cleanupProbeArtifacts,
  redactSensitive,
  removeOwnedSmokeProjectEntries,
  renderAgentsMd,
  renderConfig,
  rollbackConfig,
  summarizeRollout,
  validateTypedSpawnArgs,
  validateRoleText,
  verifyProbe,
  writeJson,
} from "../lib/gearbox.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

test("renderConfig adds only marker-delimited role and v2 blocks", () => {
  const output = renderConfig(CONFIG_FIXTURE, "/home/test/.codex");
  assert.match(output, new RegExp(CONFIG_ROLES_MARKER));
  assert.match(output, new RegExp(CONFIG_V2_MARKER));
  assert.match(output, /^\[agents\.luna_clerk\]$/m);
  assert.match(output, /^\[agents\.terra_worker\]$/m);
  assert.match(output, /^\[features\.multi_agent_v2\]$/m);
  assert.match(output, /^max_concurrent_threads_per_session = 2$/m);
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
  assert.match(WORKFLOW_POLICY, /subagent-driven-development/);
  assert.match(WORKFLOW_POLICY, /dispatching-parallel-agents/);
  assert.match(WORKFLOW_POLICY, /requesting-code-review/);
  assert.match(WORKFLOW_POLICY, /security-scan/);
  assert.match(WORKFLOW_POLICY, /security-diff-scan/);
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

test("managed dispatch runtime is bound into the installer and packaged with the exact wrapper", async () => {
  const installer = await readFile(join(REPO_ROOT, "scripts", "gearbox.mjs"), "utf8");
  const wrapper = await readFile(join(REPO_ROOT, "scripts", "gearbox-dispatch"), "utf8");
  const wrapperMode = (await stat(join(REPO_ROOT, "scripts", "gearbox-dispatch"))).mode & 0o777;
  assert.match(installer, /DISPATCH_RUNTIME_FILES/);
  assert.match(installer, /scripts\/gearbox-dispatch/);
  assert.match(installer, /dispatchMode/);
  assert.equal(wrapperMode, 0o755);
  assert.equal(
    wrapper,
    "#!/usr/bin/env bash\nset -euo pipefail\nCODEX_HOME_DIR=\"${CODEX_HOME:-${HOME}/.codex}\"\nexec node \"$CODEX_HOME_DIR/gearbox/runtime/scripts/gearbox-dispatch.mjs\" \"$@\"\n",
  );
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
