import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENTS_MARKER,
  CONFIG_LEGACY_THREADS_MARKER,
  CONFIG_ROLES_MARKER,
  CONFIG_V2_MARKER,
  ROLE_SPECS,
  redactSensitive,
  removeOwnedSmokeProjectEntries,
  renderAgentsMd,
  renderConfig,
  rollbackConfig,
  validateRoleText,
  verifyProbe,
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
  assert.match(output, /## Later Section\n\nKeep me\./);
  assert.doesNotMatch(output, /old rule|old trigger/);
  assert.equal(renderAgentsMd(output), output);
});

test("all checked-in role files match their role specs", async () => {
  for (const spec of ROLE_SPECS) {
    const source = await readFile(join(REPO_ROOT, "roles", spec.sourceFile), "utf8");
    const result = validateRoleText(spec, source);
    assert.equal(result.pass, true, `${spec.name}: ${JSON.stringify(result.checks)}`);
  }
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

test("verifyProbe requires typed lineage, exact runtime settings, and no descendants", () => {
  const spec = ROLE_SPECS.find((role) => role.name === "terra_worker");
  const parent = {
    sessionMeta: { id: "parent" },
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
  });
  assert.equal(result.pass, true);
  assert.equal(result.checks.parentTokenUsagePersisted, true);

  const missingParentUsage = verifyProbe({
    spec,
    parent: { ...parent, tokenUsage: null },
    child,
    marker: "ROLE_PROBE_OK:terra_worker",
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
  });
  assert.equal(untyped.pass, false);
  assert.equal(untyped.checks.typedRoleRequested, false);
});
