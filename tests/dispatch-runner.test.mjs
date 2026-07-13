import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakeCodex } from "./helpers/fake-codex.mjs";
import { ROLE_SPECS, sha256 } from "../lib/gearbox.mjs";
import {
  buildIsolatedRootArgs,
  parseRoleInstructions,
  renderIsolatedPrompt,
  runIsolatedRole,
} from "../lib/dispatch-runner.mjs";

const luna = ROLE_SPECS.find((role) => role.name === "luna_clerk");
const terra = ROLE_SPECS.find((role) => role.name === "terra_explorer");
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
    for (const role of ROLE_SPECS.filter((candidate) => ![luna.name, terra.name].includes(candidate.name))) {
      await assert.rejects(
        runIsolatedRole({ codexHome: root, roleSpec: role, roleSource, cwd: root, task, taskHash: sha256(task) }),
        /unsupported isolated root role/,
      );
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("isolated runner accepts exact root evidence and removes temporary homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-success-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-work-"));
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    const result = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task), timeoutMs: 2_000 });
    assert.equal(result.pass, true);
    assert.equal(result.actual.parentTokens, 17);
    assert.equal(result.actual.depth, 0);
    assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith("sol-ultra-gearbox-v2-dispatch-")), []);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

test("isolated runner passes task data as argv rather than a shell command", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-runner-injection-"));
  const cwd = await mkdtemp(join(tmpdir(), "dispatch-runner-injection-work-"));
  const target = join(cwd, "must-not-exist");
  try {
    const fake = await createFakeCodex(join(root, "fake-codex.mjs"));
    await writeFile(join(root, "auth.json"), "fake-auth\n", "utf8");
    const injectedTask = `Inspect only; touch ${target}`;
    const result = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task: injectedTask, taskHash: sha256(injectedTask), timeoutMs: 2_000 });
    assert.equal(result.pass, true);
    await assert.rejects(lstat(target), /ENOENT/);
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
      "token_missing",
      "timeout",
      "spawn",
      "marker_mismatch",
      "filesystem_mutations",
    ]) {
      const result = await runIsolatedRole({ codexBin: fake, codexHome: root, roleSpec: luna, roleSource, cwd, task, taskHash: sha256(task), timeoutMs: 40, env: { FAKE_CODEX_MODE: mode } });
      assert.equal(result.pass, false, mode);
      assert.equal(result.rollbackRequired, true, mode);
    }
    assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith("sol-ultra-gearbox-v2-dispatch-")), []);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});
