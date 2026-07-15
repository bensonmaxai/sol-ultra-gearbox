import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  renderConfig,
  rollbackConfig,
  sha256,
} from "../lib/gearbox.mjs";
import { mcpConfigDoctorPasses } from "../scripts/gearbox.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(REPO_ROOT, "scripts", "gearbox.mjs");
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

test("doctor accepts only the explicit optional MCP reachability warning", () => {
  assert.equal(mcpConfigDoctorPasses({ status: "ok" }), true);
  assert.equal(mcpConfigDoctorPasses({
    status: "warning",
    summary: "MCP configuration has optional issues",
    details: {
      "configured servers": "1",
      "disabled servers": "0",
      "optional reachability failed": "fixture endpoint unavailable",
      "stdio servers": "0",
      "streamable_http servers": "1",
    },
  }), true);
  assert.equal(mcpConfigDoctorPasses({
    status: "warning",
    summary: "MCP configuration has optional issues",
    details: {},
  }), false);
  assert.equal(mcpConfigDoctorPasses({
    status: "warning",
    summary: "MCP configuration is invalid",
    details: {
      "configured servers": "1",
      "disabled servers": "0",
      "optional reachability failed": "fixture endpoint unavailable",
      "stdio servers": "0",
      "streamable_http servers": "1",
    },
  }), false);
  assert.equal(mcpConfigDoctorPasses({
    status: "warning",
    summary: "MCP configuration has optional issues",
    details: {
      "configured servers": "1",
      "disabled servers": "0",
      "optional reachability failed": "fixture endpoint unavailable",
      "stdio servers": "0",
      "streamable_http servers": "1",
      "permission problem": "present",
    },
  }), false);
  assert.equal(mcpConfigDoctorPasses({ status: "fail" }), false);
});

async function tree(root) {
  const output = {};
  async function visit(path) {
    const metadata = await lstat(path);
    const key = path === root ? "." : path.slice(root.length + 1);
    output[key] = {
      type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
      mode: metadata.mode & 0o777,
      sha256: metadata.isFile() ? sha256(await readFile(path)) : null,
    };
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    }
  }
  await visit(root);
  return output;
}

function run(args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("active apply dry-run is a no-write preview and never claims acceptance was validated", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gearbox-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "config.toml"), `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n\n[agents]\nmax_depth = 1\n`, { mode: 0o600 });
  await writeFile(join(home, "AGENTS.md"), "# Fixture policy\n", { mode: 0o600 });
  await writeFile(join(home, "models_cache.json"), `${JSON.stringify({ models: [
    { slug: "gpt-5.6-luna", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "gpt-5.6-terra", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }, { effort: "ultra" }, { effort: "max" }] },
    { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }] },
  ] })}\n`, { mode: 0o600 });
  const fakeCodex = join(home, "fake-codex.mjs");
  await writeFile(fakeCodex, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "features" && args[1] === "list") {
  process.stdout.write("multi_agent stable true\\nmulti_agent_v2 under development true\\n");
} else if (args[0] === "doctor" && args[1] === "--json") {
  process.stdout.write(JSON.stringify({ checks: { "config.load": { status: "ok" }, "mcp.config": { status: "warning", summary: "MCP configuration has optional issues", details: { "configured servers": "1", "disabled servers": "0", "optional reachability failed": "fixture endpoint unavailable", "stdio servers": "0", "streamable_http servers": "1" } }, installation: { status: "ok" } } }));
} else {
  process.stdout.write("codex-cli 1.2.3\\n");
}
`, { mode: 0o700 });
  await chmod(fakeCodex, 0o700);

  const before = await tree(home);
  const result = await run(
    ["apply", "--promote-v2", "--dry-run", "--dispatch-mode", "active"],
    { CODEX_HOME: home, CODEX_BIN: fakeCodex },
  );
  const after = await tree(home);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.pass, true);
  assert.equal(report.changes.dispatch.mode, "active");
  assert.equal(report.changes.dispatch.acceptanceRequired, true);
  assert.equal(report.changes.dispatch.acceptanceValidated, false);
  assert.deepEqual(report.changes.dispatch.rootProvider, {
    kind: "app_server_root",
    enabled: true,
    transport: "stdio",
    protocolVersion: 1,
    acceptanceBound: true,
  });
  assert.deepEqual(
    WORKFLOW_RUNTIME_FILES,
    report.changes.dispatch.runtime
      .map((entry) => entry.path)
      .filter((path) => WORKFLOW_RUNTIME_FILES.includes(path)),
  );
  assert.ok(report.changes.dispatch.runtime.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.equal(report.changes.dispatch.rootWrapper.path, "scripts/gearbox-root");
  assert.match(report.changes.dispatch.rootWrapper.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(after, before);
});

test("managed rollback force-recovers a legacy failed manifest by exact config hash", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gearbox-cli-legacy-rollback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = join(home, "config.toml");
  const agentsPath = join(home, "AGENTS.md");
  const base = `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "max"\n\n[agents]\nmax_threads = 3\nmax_depth = 1\n\n[private_fixture]\nsecret_value = "SECRET_KEEP"\n`;
  const previous = renderConfig(base, home)
    .replace(
      "max_concurrent_threads_per_session = 3",
      "max_concurrent_threads_per_session = 2",
    );
  const stripped = rollbackConfig(renderConfig(previous, home));
  await writeFile(configPath, stripped, { mode: 0o600 });
  await writeFile(agentsPath, "# restored fixture\n", { mode: 0o600 });
  const manifestPath = join(home, "reports", "failed", "install-manifest.json");
  await mkdir(join(home, "reports", "failed"), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    timestamp: "legacy-fixture",
    status: "failed_rolled_back",
    config: {
      path: configPath,
      beforeSha256: sha256(previous),
      afterSha256: sha256(renderConfig(previous, home)),
      mode: 0o600,
    },
    agents: { path: agentsPath },
    files: [],
    rollback: { at: new Date().toISOString(), reason: "fixture", actions: [] },
  }, null, 2)}\n`, { mode: 0o600 });

  const result = await run(
    ["rollback", "--manifest", manifestPath, "--force"],
    { CODEX_HOME: home },
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /GEARBOX_ROLLBACK_FAILED_ROLLED_BACK/);
  assert.equal(await readFile(configPath, "utf8"), previous);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const recovery = manifest.rollback.actions.find((action) => action.path === configPath);
  assert.equal(recovery.action, "managed_config_recovered");
  assert.equal(recovery.strategy, "legacy_v2_hash_match");
  assert.equal(recovery.exact, true);
  assert.equal(recovery.sha256, sha256(previous));
  assert.doesNotMatch(JSON.stringify(manifest), /SECRET_KEEP/);
});
