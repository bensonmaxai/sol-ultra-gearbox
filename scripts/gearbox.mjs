#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS_MARKER,
  CONFIG_LEGACY_THREADS_MARKER,
  CONFIG_ROLES_MARKER,
  CONFIG_V2_MARKER,
  DISPATCH_RUNTIME_FILES,
  RUNTIME_BINDING_FILES,
  ROLE_SPECS,
  atomicWrite,
  backupFile,
  cleanupProbeArtifacts,
  findRecentRollouts,
  findProbeRollouts,
  hashTree,
  installDispatchRuntime,
  readOptional,
  redactSensitive,
  removeOwnedSmokeProjectEntries,
  renderAgentsMd,
  renderConfig,
  restoreBackup,
  rollbackConfig,
  rollbackDispatchRuntime,
  sha256,
  summarizeRollout,
  validateTypedSpawnArgs,
  validateRoleText,
  verifyProbe,
  writeJson,
} from "../lib/gearbox.mjs";
import { runIsolatedRole } from "../lib/dispatch-runner.mjs";
import {
  ACCEPTANCE_PARALLEL_CHILDREN,
  attachAcceptanceMetadata,
  evaluateAcceptanceViolation,
  planAcceptanceScenario,
  runAcceptanceExam,
  validateAcceptanceDeliverable,
} from "../lib/acceptance-exam.mjs";
import { validateDispatchResult } from "../lib/dispatch-evidence.mjs";
import {
  assertManagedPolicyTarget,
  createDispatchPolicy,
  DISPATCH_POLICY_RELATIVE_PATH,
  serializeDispatchPolicy,
} from "../lib/dispatch-policy.mjs";
import {
  createRuntimeBinding,
  validateSddAdapterEvidence,
  validateTrustedAcceptance,
  validateTrustedSmoke,
} from "../lib/runtime-evidence.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const SMOKE_ROOT = Object.freeze({ model: "gpt-5.6-sol", effort: "max" });
const APP_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_BIN =
  process.env.CODEX_BIN ?? (existsSync(APP_CODEX_BIN) ? APP_CODEX_BIN : "codex");
function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function rolePath(spec) {
  return join(REPO_ROOT, "roles", spec.sourceFile);
}

function installedRolePath(spec) {
  return join(CODEX_HOME, "agents", spec.installFile);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function runCommand(
  command,
  args,
  { cwd = REPO_ROOT, timeoutMs = 600_000, env = {} } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? -1,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function parseJsonObject(output) {
  const start = output.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

function safeErrorSummary(output) {
  return output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /\b(authorization|bearer|api[_-]?key|token|secret|password)\b\s*[:=]?\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .trim()
    .slice(-4000);
}

async function readBoundSource(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime binding refuses non-regular source: ${relative(REPO_ROOT, path)}`);
  }
  return readFile(path);
}

async function collectRuntimeBinding() {
  const [headResult, statusResult, versionResult, configSource] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"]),
    runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
    runCommand(CODEX_BIN, ["--version"]),
    readFile(join(CODEX_HOME, "config.toml"), "utf8"),
  ]);
  if (headResult.code !== 0 || statusResult.code !== 0 || versionResult.code !== 0) {
    throw new Error("Unable to collect a complete runtime binding");
  }
  const roleHashes = {};
  for (const spec of ROLE_SPECS) {
    roleHashes[spec.name] = sha256(await readBoundSource(rolePath(spec)));
  }
  const runtimeHashes = {};
  for (const path of RUNTIME_BINDING_FILES) {
    runtimeHashes[path] = sha256(
      await readBoundSource(join(REPO_ROOT, path)),
    );
  }
  return createRuntimeBinding({
    gitHead: headResult.stdout.trim(),
    gitStatus: statusResult.stdout,
    codexVersion: versionResult.stdout.trim().split(/\r?\n/).at(-1),
    configSha256: sha256(configSource),
    roleHashes,
    runtimeHashes,
  });
}

async function loadTrustedSmoke(reportPath) {
  const reportsPath = join(REPO_ROOT, "reports");
  const reportsMetadata = await lstat(reportsPath);
  if (!reportsMetadata.isDirectory() || reportsMetadata.isSymbolicLink()) {
    throw new Error("Repository reports directory must be a real directory");
  }
  const reportsRoot = await realpath(reportsPath);
  const requestedPath = resolve(reportPath);
  const metadata = await lstat(requestedPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Trusted smoke path must be a regular non-symlink file");
  }
  const actualPath = await realpath(requestedPath);
  const pathFromReports = relative(reportsRoot, actualPath);
  if (
    pathFromReports === "" ||
    pathFromReports === ".." ||
    pathFromReports.startsWith(`..${sep}`) ||
    resolve(reportsRoot, pathFromReports) !== actualPath
  ) {
    throw new Error("Trusted smoke path must remain under this repository's reports directory");
  }
  const report = JSON.parse(await readFile(actualPath, "utf8"));
  const currentBinding = await collectRuntimeBinding();
  const validation = validateTrustedSmoke({
    report,
    currentBinding,
    expectedRoles: ROLE_SPECS.filter((role) => role.smoke),
    expectedRoot: SMOKE_ROOT,
  });
  if (!validation.pass) {
    const failed = Object.entries(validation.checks)
      .filter(([, pass]) => !pass)
      .map(([name]) => name)
      .join(", ");
    throw new Error(`Trusted smoke reuse rejected: ${failed}`);
  }
  return {
    ...report,
    reportDirectory: dirname(actualPath),
    reuse: {
      mode: "trusted_recent_smoke",
      validatedAt: new Date().toISOString(),
      ageMs: validation.ageMs,
      ttlMs: validation.ttlMs,
    },
  };
}

async function loadTrustedAcceptance(reportPath) {
  const reportsPath = join(REPO_ROOT, "reports");
  const reportsMetadata = await lstat(reportsPath);
  if (!reportsMetadata.isDirectory() || reportsMetadata.isSymbolicLink()) {
    throw new Error("Repository reports directory must be a real directory");
  }
  const reportsRoot = await realpath(reportsPath);
  const requestedPath = resolve(reportPath);
  const metadata = await lstat(requestedPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Trusted acceptance path must be a regular non-symlink file");
  }
  const actualPath = await realpath(requestedPath);
  const pathFromReports = relative(reportsRoot, actualPath);
  if (
    pathFromReports === "" || pathFromReports === ".." ||
    pathFromReports.startsWith(`..${sep}`) || resolve(reportsRoot, pathFromReports) !== actualPath
  ) {
    throw new Error("Trusted acceptance path must remain under this repository's reports directory");
  }
  const report = JSON.parse(await readFile(actualPath, "utf8"));
  const validation = validateTrustedAcceptance({
    report,
    currentBinding: await collectRuntimeBinding(),
    reportFile: { pathConfined: true, regular: true, symlink: false },
  });
  if (!validation.pass) {
    const failed = Object.entries(validation.checks).filter(([, pass]) => !pass).map(([name]) => name).join(", ");
    throw new Error(`Trusted acceptance reuse rejected: ${failed}`);
  }
  return attachAcceptanceMetadata(report, {
    reportDirectory: dirname(actualPath),
    reuse: { mode: "trusted_recent_acceptance", validatedAt: new Date().toISOString(), ageMs: validation.ageMs, ttlMs: validation.ttlMs },
  });
}

function acceptanceRuntime(summary) {
  return {
    persisted: Boolean(summary?.sessionMeta && summary?.turnContext),
    model: summary?.turnContext?.model ?? null,
    effort: summary?.turnContext?.effort ?? null,
    tokenUsage: summary?.tokenUsage ?? null,
  };
}

async function singleRootSummary(sessionRoot, cwd, sinceMs) {
  const paths = await findRecentRollouts(sessionRoot, sinceMs);
  const summaries = await Promise.all(paths.map((path) => summarizeRollout(path)));
  const roots = summaries.filter((summary) =>
    summary?.sessionMeta?.cwd === cwd && summary?.threadSource !== "subagent",
  );
  return roots.length === 1 ? roots[0] : null;
}

function acceptanceResult(scenario, { decision = null, ...values } = {}) {
  return {
    id: scenario.id,
    selectedShape: decision?.selectedShape ?? null,
    reasonCode: decision?.reasonCode ?? null,
    pass: false,
    runtime: null,
    cleanup: { pass: false },
    ...values,
  };
}

export async function runAcceptanceRoot(scenario, { decision = null, priorResults = new Map() } = {}) {
  if (scenario.id === "Q8_RUNTIME_MISMATCH_REJECTED" || scenario.id === "Q9_WRITE_VIOLATION_REJECTED") {
    const evidence = priorResults.get("Q2_ISOLATED_LUNA")?.dispatchEvidence;
    if (!evidence) return acceptanceResult(scenario, { decision, hardFailure: "runtime" });
    const evaluated = evaluateAcceptanceViolation({
      ...evidence,
      violation: scenario.id === "Q8_RUNTIME_MISMATCH_REJECTED"
        ? "runtime_mismatch"
        : "filesystem_write",
    });
    return acceptanceResult(scenario, {
      decision: { selectedShape: evaluated.selectedShape, reasonCode: evaluated.reasonCode },
      pass: evaluated.pass,
      runtime: evaluated.runtime,
      cleanup: evaluated.cleanup,
      violationDetected: evaluated.violationDetected,
      rejected: evaluated.rejected,
      hardFailure: evaluated.pass ? null : "runtime",
    });
  }
  const fixture = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-dispatch-luna_clerk-"));
  const probeHome = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-dispatch-home-luna_clerk-"));
  const authLink = join(probeHome, "auth.json");
  let cleanup = false;
  let answer;
  try {
    await writeFile(join(fixture, "fixture.txt"), "BEFORE\n", "utf8");
    await symlink(join(CODEX_HOME, "auth.json"), authLink);
    const marker = `ACCEPTANCE_ROOT_OK:${scenario.id}`;
    const writeTask = scenario.id === "Q1_ROOT_TRIVIAL"
      ? "Replace the single line BEFORE with AFTER in fixture.txt. Do not spawn or delegate."
      : "Read fixture.txt. Do not edit, spawn, or delegate.";
    const startedAtMs = Date.now();
    const command = await runCommand(CODEX_BIN, [
      "--strict-config", "-c", 'model="gpt-5.6-sol"', "-c", 'model_reasoning_effort="ultra"',
      "-s", scenario.id === "Q1_ROOT_TRIVIAL" ? "workspace-write" : "read-only", "-a", "never", "-C", fixture,
      "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
      `${writeTask} Return exactly ${marker}.`,
    ], { cwd: fixture, timeoutMs: 900_000, env: { CODEX_HOME: probeHome } });
    const summary = await singleRootSummary(join(probeHome, "sessions"), fixture, startedAtMs);
    const runtime = acceptanceRuntime(summary);
    const clean = (summary?.functionCalls ?? []).filter((call) => call?.name?.endsWith("spawn_agent")).length === 0;
    const markerReturned = (summary?.finalTexts ?? []).some((text) => text.includes(marker));
    const fixtureContent = await readFile(join(fixture, "fixture.txt"), "utf8");
    const filesystemPass = scenario.id === "Q1_ROOT_TRIVIAL"
      ? fixtureContent === "AFTER\n"
      : fixtureContent === "BEFORE\n";
    answer = acceptanceResult(scenario, {
      decision,
      pass: command.code === 0 && !command.timedOut && clean && markerReturned && filesystemPass && runtime.persisted,
      runtime,
      cleanup: { pass: false },
      hardFailure: command.code === 0 && !command.timedOut ? null : "runtime",
    });
  } catch {
    answer = acceptanceResult(scenario, { decision, hardFailure: "runtime" });
  } finally {
    await unlink(authLink).catch(() => {});
    try {
      const removed = await cleanupProbeArtifacts([probeHome, fixture]);
      cleanup = removed.removed.length === 2;
    } catch {
      cleanup = false;
    }
  }
  return { ...answer, cleanup: { pass: cleanup } };
}

export async function runAcceptanceIsolated(scenario, {
  decision = null,
  executeIsolatedRole = runIsolatedRole,
  codexBin = CODEX_BIN,
  codexHome = CODEX_HOME,
} = {}) {
  const roleName = scenario.id === "Q2_ISOLATED_LUNA" ? "luna_clerk" : "terra_explorer";
  const spec = ROLE_SPECS.find((role) => role.name === roleName);
  const fixture = await mkdtemp(join(tmpdir(), `sol-ultra-gearbox-v2-dispatch-${roleName}-`));
  let cleanup = false;
  let answer;
  try {
    const records = Array.from({ length: 25 }, (_, index) => `record-${index + 1}`).join("\n");
    await writeFile(join(fixture, "records.txt"), `${records}\n`, "utf8");
    for (let index = 0; index < 5; index += 1) await writeFile(join(fixture, `trace-${index}.txt`), `trace ${index}\n`, "utf8");
    const task = roleName === "luna_clerk"
      ? "Read only records.txt. Count its non-empty records. Return exactly one JSON object with no markdown and no extra keys: {\"count\":25}."
      : "Read only the five trace-*.txt files. Return exactly one JSON object with no markdown and the filenames sorted ascending under the sole key filenames: {\"filenames\":[\"trace-0.txt\",\"trace-1.txt\",\"trace-2.txt\",\"trace-3.txt\",\"trace-4.txt\"]}.";
    let deliverableValid = false;
    const result = await executeIsolatedRole({
      codexBin, codexHome, roleSpec: spec,
      roleSource: await readFile(rolePath(spec), "utf8"), cwd: fixture, task,
      taskHash: sha256(task),
      onDeliverable: async (value) => {
        deliverableValid = validateAcceptanceDeliverable(scenario.id, value);
        return deliverableValid;
      },
    });
    const runnerDecision = {
      selectedShape: result.executionShape,
      role: result.role,
      reasonCode: result.reasonCode,
      taskHash: result.taskHash,
      roleHash: result.expected?.roleHash,
    };
    const validation = validateDispatchResult({ result, decision: runnerDecision, roleSpec: spec });
    const plannerMatches = decision?.selectedShape === runnerDecision.selectedShape &&
      decision?.reasonCode === runnerDecision.reasonCode && decision?.role === runnerDecision.role;
    answer = acceptanceResult(scenario, {
      decision: runnerDecision,
      pass: result.pass && validation.pass && plannerMatches && deliverableValid,
      runtime: { persisted: result.checks?.runtimePersisted === true, model: result.actual?.model, effort: result.actual?.effort, tokenUsage: { total_tokens: result.actual?.parentTokens } },
      cleanup: { pass: false },
      hardFailure: result.rollbackRequired || !validation.pass ? "runtime" : null,
      dispatchEvidence: { result, decision: runnerDecision, roleSpec: spec },
    });
  } catch {
    answer = acceptanceResult(scenario, { decision, hardFailure: "runtime" });
  } finally {
    try {
      const removed = await cleanupProbeArtifacts([fixture]);
      cleanup = removed.removed.length === 1;
    } catch { cleanup = false; }
  }
  return { ...answer, cleanup: { pass: cleanup } };
}

function spawnedChildren(parent, summaries) {
  const parentId = parent?.sessionId ?? parent?.sessionMeta?.id ?? parent?.sessionMeta?.session_id;
  return summaries.filter((summary) =>
    summary?.sessionMeta?.source?.subagent?.thread_spawn?.parent_thread_id === parentId,
  );
}

function exactParallelSpawn(args, expected) {
  return JSON.stringify(Object.keys(args ?? {}).sort()) ===
      JSON.stringify(["agent_type", "fork_turns", "message", "task_name"].sort()) &&
    args.agent_type === expected.role && args.task_name === expected.taskName &&
    args.fork_turns === "none" && args.message === expected.message &&
    validateTypedSpawnArgs(args).pass;
}

function acceptanceChildFacts(child, expected, spawnArgs) {
  const sandbox = child?.turnContext?.sandbox_policy?.type ?? null;
  return {
    role: child?.sessionMeta?.agent_role ?? child?.sessionMeta?.source?.subagent?.thread_spawn?.agent_role ?? null,
    model: child?.turnContext?.model ?? null,
    effort: child?.turnContext?.effort ?? null,
    depth: child?.sessionMeta?.source?.subagent?.thread_spawn?.depth ?? null,
    sandbox,
    writer: sandbox !== "read-only",
    descendants: (child?.functionCalls ?? []).filter((call) => call?.name?.endsWith("spawn_agent")).length,
    readScope: exactParallelSpawn(spawnArgs, expected) ? expected.readScope : null,
    markerReturned: (child?.finalTexts ?? []).some((text) => text.trim() === expected.marker),
    runtimePersisted: Boolean(child?.sessionMeta && child?.turnContext),
    tokenUsage: child?.tokenUsage ?? null,
  };
}

async function snapshotAcceptanceTree(root) {
  const entries = {};
  async function visit(path) {
    const metadata = await lstat(path);
    const key = relative(root, path) || ".";
    if (metadata.isSymbolicLink()) {
      entries[key] = { type: "symlink", mode: metadata.mode & 0o7777, target: await readlink(path) };
      return;
    }
    if (metadata.isDirectory()) {
      entries[key] = { type: "directory", mode: metadata.mode & 0o7777 };
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
      return;
    }
    entries[key] = metadata.isFile()
      ? { type: "file", mode: metadata.mode & 0o7777, sha256: sha256(await readFile(path)) }
      : { type: "other", mode: metadata.mode & 0o7777 };
  }
  await visit(root);
  return entries;
}

export async function runAcceptanceParallel(scenario, { decision = null } = {}) {
  const fixture = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-dispatch-luna_clerk-"));
  const probeHome = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-dispatch-home-luna_clerk-"));
  const authLink = join(probeHome, "auth.json");
  let cleanup = false;
  let answer;
  try {
    await writeFile(join(fixture, "reader-a.txt"), "alpha\n", "utf8");
    await writeFile(join(fixture, "reader-b.txt"), "beta\n", "utf8");
    const beforeTree = await snapshotAcceptanceTree(fixture);
    await symlink(join(CODEX_HOME, "auth.json"), authLink);
    const luna = ROLE_SPECS.find((role) => role.name === "luna_clerk");
    const terra = ROLE_SPECS.find((role) => role.name === "terra_explorer");
    const startedAtMs = Date.now();
    const parentMarker = "Q10_PARENT_OK";
    const exactCalls = ACCEPTANCE_PARALLEL_CHILDREN.map((child) => JSON.stringify({
      agent_type: child.role,
      fork_turns: "none",
      message: child.message,
      task_name: child.taskName,
    }));
    const prompt = [
      "This is an explicitly authorized acceptance fixture.",
      "Call spawn_agent exactly twice and no other delegation.",
      `Use exactly these argument objects and no extra fields:\n${exactCalls.join("\n")}`,
      `Do not pass model, reasoning_effort, model_reasoning_effort, or service_tier. Wait for both children. Do not edit files. After both exact child markers arrive, reply exactly ${parentMarker}.`,
    ].join("\n");
    const command = await runCommand(CODEX_BIN, [
      "--strict-config", "-c", "features.multi_agent_v2.enabled=true", "-c", "features.multi_agent_v2.max_concurrent_threads_per_session=2",
      "-c", "features.multi_agent_v2.hide_spawn_agent_metadata=false", "-c", 'features.multi_agent_v2.tool_namespace="agents"', "-c", "agents.max_depth=1",
      "-c", `agents.${luna.name}.description=${JSON.stringify(luna.description)}`, "-c", `agents.${luna.name}.config_file=${JSON.stringify(rolePath(luna))}`,
      "-c", `agents.${terra.name}.description=${JSON.stringify(terra.description)}`, "-c", `agents.${terra.name}.config_file=${JSON.stringify(rolePath(terra))}`,
      "-c", 'model="gpt-5.6-sol"', "-c", 'model_reasoning_effort="ultra"', "-s", "read-only", "-a", "never", "-C", fixture,
      "exec", "--json", "--skip-git-repo-check", "--ignore-user-config", prompt,
    ], { cwd: fixture, timeoutMs: 900_000, env: { CODEX_HOME: probeHome } });
    const paths = await findRecentRollouts(join(probeHome, "sessions"), startedAtMs);
    const summaries = await Promise.all(paths.map((path) => summarizeRollout(path)));
    const parents = summaries.filter((summary) => summary?.sessionMeta?.cwd === fixture && summary?.threadSource !== "subagent");
    const parent = parents.length === 1 ? parents[0] : null;
    const children = spawnedChildren(parent, summaries);
    const spawnCalls = (parent?.functionCalls ?? []).filter((call) => call?.name?.endsWith("spawn_agent"));
    const validSpawns = spawnCalls.length === ACCEPTANCE_PARALLEL_CHILDREN.length &&
      ACCEPTANCE_PARALLEL_CHILDREN.every((expected) =>
        spawnCalls.filter((call) => exactParallelSpawn(call?.args, expected)).length === 1,
      );
    const childFacts = children.map((child) => {
      const role = child?.sessionMeta?.agent_role ?? child?.sessionMeta?.source?.subagent?.thread_spawn?.agent_role;
      const expected = ACCEPTANCE_PARALLEL_CHILDREN.find((entry) => entry.role === role);
      const spawnCall = spawnCalls.find((call) => call?.args?.agent_type === role);
      return expected
        ? acceptanceChildFacts(child, expected, spawnCall?.args)
        : { role, model: null, effort: null, depth: null, sandbox: null, writer: true, descendants: 0, readScope: null, markerReturned: false, runtimePersisted: false, tokenUsage: null };
    });
    const parentId = parent?.sessionId ?? parent?.sessionMeta?.id ?? parent?.sessionMeta?.session_id;
    const childIds = children.map((child) => child?.sessionId ?? child?.sessionMeta?.id ?? child?.sessionMeta?.session_id);
    const lineageExact = parents.length === 1 && summaries.length === 3 && children.length === 2 &&
      typeof parentId === "string" && new Set(childIds).size === 2 &&
      childIds.every((id) => typeof id === "string" && id !== parentId) &&
      children.every((child) => child?.sessionMeta?.source?.subagent?.thread_spawn?.parent_thread_id === parentId);
    const afterTree = await snapshotAcceptanceTree(fixture);
    const filesystemUnchanged = JSON.stringify(beforeTree) === JSON.stringify(afterTree);
    const parentMarkerReturned = (parent?.finalTexts ?? []).some((text) => text.trim() === parentMarker);
    const topology = {
      parent: { model: parent?.turnContext?.model, effort: parent?.turnContext?.effort, runtimePersisted: Boolean(parent?.sessionMeta && parent?.turnContext), tokenUsage: parent?.tokenUsage ?? null },
      children: childFacts,
      writerCount: 0,
      descendantCount: childFacts.reduce((count, child) => count + child.descendants, 0),
      spawnsExact: validSpawns,
      lineageExact,
      filesystemUnchanged,
      parentMarkerReturned,
    };
    topology.writerCount = childFacts.filter((child) => child.writer).length;
    const childRuntime = childFacts.length === 2 && ACCEPTANCE_PARALLEL_CHILDREN.every((spec) =>
      childFacts.some((child) => child.role === spec.role && child.model === spec.model && child.effort === spec.effort &&
        child.depth === 1 && child.sandbox === "read-only" && child.runtimePersisted && child.markerReturned &&
        Number.isFinite(child.tokenUsage?.total_tokens)),
    );
    answer = acceptanceResult(scenario, {
      decision,
      pass: command.code === 0 && !command.timedOut && validSpawns && childRuntime &&
        lineageExact && filesystemUnchanged && parentMarkerReturned && topology.writerCount === 0 && topology.descendantCount === 0,
      runtime: acceptanceRuntime(parent),
      topology,
      cleanup: { pass: false },
      hardFailure: command.code === 0 && !command.timedOut ? null : "runtime",
    });
  } catch {
    answer = acceptanceResult(scenario, { decision, hardFailure: "runtime" });
  } finally {
    await unlink(authLink).catch(() => {});
    try { cleanup = (await cleanupProbeArtifacts([probeHome, fixture])).removed.length === 2; } catch { cleanup = false; }
  }
  return { ...answer, cleanup: { pass: cleanup } };
}

async function runDoctor() {
  const roleChecks = [];
  for (const spec of ROLE_SPECS) {
    const source = await readFile(rolePath(spec), "utf8");
    roleChecks.push({ role: spec.name, ...validateRoleText(spec, source) });
  }

  const modelCachePath = join(CODEX_HOME, "models_cache.json");
  const modelCache = JSON.parse(await readFile(modelCachePath, "utf8"));
  const modelChecks = ROLE_SPECS.map((role) => {
    const model = modelCache.models?.find((candidate) => candidate.slug === role.model);
    const efforts = model?.supported_reasoning_levels?.map((item) => item.effort) ?? [];
    return {
      role: role.name,
      model: role.model,
      effort: role.effort,
      supportedEfforts: efforts,
      present: Boolean(model),
      effortSupported: efforts.includes(role.effort),
      multiAgentVersion: model?.multi_agent_version ?? null,
    };
  });

  const configPath = join(CODEX_HOME, "config.toml");
  const configSource = await readFile(configPath, "utf8");
  let patchable = true;
  let patchError = null;
  try {
    renderConfig(configSource, CODEX_HOME, { promoteV2: true });
  } catch (error) {
    patchable = false;
    patchError = error.message;
  }

  const strictArgs = [
    "--strict-config",
    "-c",
    "features.multi_agent_v2.enabled=true",
    "-c",
    "features.multi_agent_v2.max_concurrent_threads_per_session=2",
    "-c",
    "features.multi_agent_v2.hide_spawn_agent_metadata=false",
    "-c",
    'features.multi_agent_v2.tool_namespace="agents"',
  ];
  for (const spec of ROLE_SPECS) {
    strictArgs.push(
      "-c",
      `agents.${spec.name}.description=${JSON.stringify(spec.description)}`,
      "-c",
      `agents.${spec.name}.config_file=${JSON.stringify(rolePath(spec))}`,
    );
  }
  strictArgs.push("--version");
  const strictResult = await runCommand(CODEX_BIN, strictArgs);
  const featuresResult = await runCommand(CODEX_BIN, ["features", "list"]);
  const codexDoctorResult = await runCommand(CODEX_BIN, ["doctor", "--json"], {
    timeoutMs: 120_000,
  });
  const codexDoctor = parseJsonObject(codexDoctorResult.stdout);
  const requiredDoctorChecks = ["config.load", "mcp.config", "installation"];
  const doctorChecks = Object.fromEntries(
    requiredDoctorChecks.map((name) => [
      name,
      codexDoctor?.checks?.[name]?.status === "ok",
    ]),
  );

  const checks = {
    roleFiles: roleChecks.every((item) => item.pass),
    modelCatalog: modelChecks.every(
      (item) => item.present && item.effortSupported,
    ),
    configPatchable: patchable,
    strictConfig:
      strictResult.code === 0 && strictResult.stdout.includes("codex-cli"),
    stableMultiAgent:
      featuresResult.code === 0 &&
      /^multi_agent\s+stable\s+true$/m.test(featuresResult.stdout),
    experimentalV2Known:
      featuresResult.code === 0 &&
      /^multi_agent_v2\s+under development\s+(true|false)$/m.test(
        featuresResult.stdout,
      ),
    codexDoctor: Object.values(doctorChecks).every(Boolean),
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pass: Object.values(checks).every(Boolean),
    checks,
    roleChecks,
    modelChecks,
    config: {
      path: configPath,
      sha256: sha256(configSource),
      patchable,
      patchError,
      v2Managed: configSource.includes(CONFIG_V2_MARKER),
      rolesManaged: configSource.includes(CONFIG_ROLES_MARKER),
    },
    runtime: {
      codexBin: CODEX_BIN,
      strictConfigVersion:
        strictResult.code === 0 ? strictResult.stdout.trim().split(/\r?\n/).at(-1) : null,
      doctorChecks,
      doctorOverallStatus: codexDoctor?.overallStatus ?? "unavailable",
      terminalOnlyFailure:
        codexDoctor?.overallStatus === "fail" &&
        codexDoctor?.checks?.["terminal.env"]?.status === "fail" &&
        requiredDoctorChecks.every(
          (name) => codexDoctor?.checks?.[name]?.status === "ok",
        ),
    },
  };
}

async function createProbeFixture(spec) {
  const cwd = await mkdtemp(join(tmpdir(), `sol-ultra-gearbox-v2-${spec.name}-`));
  let task;
  if (spec.name === "luna_clerk") {
    await writeFile(join(cwd, "inventory.txt"), "bravo\nalpha\ncharlie\n", "utf8");
    task =
      "Read inventory.txt with a read-only command. Confirm it has exactly three non-empty lines. Do not edit or create files. Do not spawn another agent.";
  } else if (spec.name === "terra_explorer") {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "example.js"),
      "export function gearboxProbe() { return 42; }\n",
      "utf8",
    );
    task =
      "Inspect src/example.js and identify the exported symbol and returned value. Do not edit or create files. Do not spawn another agent.";
  } else if (
    spec.name === "terra_worker" ||
    spec.name === "terra_max_worker"
  ) {
    await writeFile(join(cwd, "worker-target.txt"), "BEFORE\n", "utf8");
    task =
      "Use apply_patch to change only worker-target.txt from BEFORE to AFTER, then verify the exact content. Do not touch any other file. Do not spawn another agent.";
  } else if (spec.name === "sol_reviewer") {
    await writeFile(
      join(cwd, "review.diff"),
      "-const RETRY_LIMIT = 3;\n+const RETRY_LIMIT = -1;\n",
      "utf8",
    );
    task =
      "Review review.diff and identify the concrete behavioral risk. Do not edit or create files. Do not spawn another agent.";
  } else if (spec.name === "terra_ultra_specialist") {
    await writeFile(
      join(cwd, "specialist.txt"),
      "constraint: no descendant agents\nanswer: bounded\n",
      "utf8",
    );
    task =
      "Read specialist.txt and confirm both key-value pairs. Do not edit or create files. Do not spawn another agent.";
  } else {
    throw new Error(`No smoke fixture for role: ${spec.name}`);
  }
  const marker = `ROLE_PROBE_OK:${spec.name}`;
  task += ` Return ${marker} in the final response.`;
  return { cwd, task, marker, before: await hashTree(cwd) };
}

async function locateProbeRollouts(options) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const found = await findProbeRollouts(options);
    if (found.parent && found.child) return found;
    await sleep(250);
  }
  return findProbeRollouts(options);
}

function treeDiff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

async function runRoleProbe(spec) {
  const fixture = await createProbeFixture(spec);
  const probeHome = await mkdtemp(
    join(tmpdir(), `sol-ultra-gearbox-v2-home-${spec.name}-`),
  );
  const authLink = join(probeHome, "auth.json");
  await symlink(join(CODEX_HOME, "auth.json"), authLink);
  const startedAtMs = Date.now();
  const parentPrompt = [
    "This is an explicitly authorized typed-role verification.",
    `Call spawn_agent exactly once with agent_type=\"${spec.name}\", task_name=\"gearbox_${spec.name}\", fork_turns=\"none\", and the self-contained message below.`,
    "Do not pass model, reasoning_effort, model_reasoning_effort, or service_tier.",
    "Wait for the child, close it, and return the child result. Do not spawn any other agent.",
    `Child message: ${fixture.task}`,
  ].join("\n");
  const args = [
    "--strict-config",
    "-c",
    "features.multi_agent_v2.enabled=true",
    "-c",
    "features.multi_agent_v2.max_concurrent_threads_per_session=2",
    "-c",
    "features.multi_agent_v2.hide_spawn_agent_metadata=false",
    "-c",
    'features.multi_agent_v2.tool_namespace="agents"',
    "-c",
    "agents.max_depth=1",
    "-c",
    `agents.${spec.name}.description=${JSON.stringify(spec.description)}`,
    "-c",
    `agents.${spec.name}.config_file=${JSON.stringify(rolePath(spec))}`,
    "-c",
    `model=${JSON.stringify(SMOKE_ROOT.model)}`,
    "-c",
    `model_reasoning_effort=${JSON.stringify(SMOKE_ROOT.effort)}`,
    "-c",
    'plugins."superpowers@openai-curated".enabled=false',
    "-s",
    spec.sandbox,
    "-a",
    "never",
    "-C",
    fixture.cwd,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    parentPrompt,
  ];
  let execution;
  let rollouts;
  try {
    execution = await runCommand(CODEX_BIN, args, {
      cwd: fixture.cwd,
      timeoutMs: 900_000,
      env: { CODEX_HOME: probeHome },
    });
    rollouts = await locateProbeRollouts({
      sessionRoot: join(probeHome, "sessions"),
      cwd: fixture.cwd,
      sinceMs: startedAtMs,
    });
  } finally {
    await unlink(authLink).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const verification = verifyProbe({
    spec,
    parent: rollouts.parent,
    child: rollouts.child,
    marker: fixture.marker,
    parentExpected: SMOKE_ROOT,
  });
  const after = await hashTree(fixture.cwd);
  const changedFiles = treeDiff(fixture.before, after);
  let filesystemPass;
  if (spec.name === "terra_worker" || spec.name === "terra_max_worker") {
    const content = await readFile(join(fixture.cwd, "worker-target.txt"), "utf8");
    filesystemPass =
      changedFiles.length === 1 &&
      changedFiles[0] === "worker-target.txt" &&
      content === "AFTER\n";
  } else {
    filesystemPass = changedFiles.length === 0;
  }
  const runtimeChecks = {
    commandExitedZero: execution.code === 0,
    commandDidNotTimeout: !execution.timedOut,
    noReservedSchemaMismatch: !/reserved .*schema mismatch|HTTP 400/i.test(
      `${execution.stdout}\n${execution.stderr}`,
    ),
    filesystemScope: filesystemPass,
  };
  const errorSummary =
    execution.code === 0 ? "" : safeErrorSummary(execution.stderr);
  if (errorSummary) {
    process.stderr.write(`SMOKE_COMMAND_ERROR ${spec.name}\n${errorSummary}\n`);
  }
  const result = {
    ...verification,
    pass:
      verification.pass && Object.values(runtimeChecks).every(Boolean),
    runtimeChecks,
    fixture: fixture.cwd,
    changedFiles,
    command: {
      exitCode: execution.code,
      timedOut: execution.timedOut,
      schemaMismatch:
        /reserved .*schema mismatch|HTTP 400/i.test(
          `${execution.stdout}\n${execution.stderr}`,
        ),
      errorSummary,
    },
  };
  let cleanup;
  try {
    cleanup = {
      pass: true,
      ...(await cleanupProbeArtifacts([probeHome, fixture.cwd])),
    };
  } catch (error) {
    cleanup = { pass: false, errorSummary: safeErrorSummary(error.message) };
  }
  result.cleanup = cleanup;
  result.runtimeChecks.temporaryArtifactsCleaned = cleanup.pass;
  result.pass = result.pass && cleanup.pass;
  return result;
}

async function runSddTypedPhase({ spec, cwd, task, marker, filesystemCheck }) {
  const before = await hashTree(cwd);
  const probeHome = await mkdtemp(
    join(tmpdir(), `sol-ultra-gearbox-v2-home-${spec.name}-`),
  );
  const authLink = join(probeHome, "auth.json");
  await symlink(join(CODEX_HOME, "auth.json"), authLink);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const parentPrompt = [
    "This is one permission-matched phase of an explicitly authorized disposable SDD adapter verification.",
    `Call spawn_agent exactly once with agent_type=\"${spec.name}\", task_name=\"sdd_${spec.name}\", fork_turns=\"none\", and the self-contained message below.`,
    "Do not pass model, reasoning_effort, model_reasoning_effort, or service_tier.",
    "Wait for the child, close it, and return the child result. Do not spawn any other agent.",
    `Child message: ${task}`,
  ].join("\n");
  const args = [
    "--strict-config",
    "-c",
    "features.multi_agent_v2.enabled=true",
    "-c",
    "features.multi_agent_v2.max_concurrent_threads_per_session=2",
    "-c",
    "features.multi_agent_v2.hide_spawn_agent_metadata=false",
    "-c",
    'features.multi_agent_v2.tool_namespace="agents"',
    "-c",
    "agents.max_depth=1",
    "-c",
    `agents.${spec.name}.description=${JSON.stringify(spec.description)}`,
    "-c",
    `agents.${spec.name}.config_file=${JSON.stringify(rolePath(spec))}`,
    "-c",
    `model=${JSON.stringify(SMOKE_ROOT.model)}`,
    "-c",
    `model_reasoning_effort=${JSON.stringify(SMOKE_ROOT.effort)}`,
    "-c",
    'plugins."superpowers@openai-curated".enabled=false',
    "-s",
    spec.sandbox,
    "-a",
    "never",
    "-C",
    cwd,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    parentPrompt,
  ];
  let execution;
  let rollouts;
  try {
    execution = await runCommand(CODEX_BIN, args, {
      cwd,
      timeoutMs: 900_000,
      env: { CODEX_HOME: probeHome },
    });
    rollouts = await locateProbeRollouts({
      sessionRoot: join(probeHome, "sessions"),
      cwd,
      sinceMs: startedAtMs,
    });
  } finally {
    await unlink(authLink).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const verification = verifyProbe({
    spec,
    parent: rollouts.parent,
    child: rollouts.child,
    marker,
    parentExpected: SMOKE_ROOT,
  });
  const after = await hashTree(cwd);
  const changedFiles = treeDiff(before, after);
  const runtimeChecks = {
    commandExitedZero: execution.code === 0,
    commandDidNotTimeout: !execution.timedOut,
    noReservedSchemaMismatch: !/reserved .*schema mismatch|HTTP 400/i.test(
      `${execution.stdout}\n${execution.stderr}`,
    ),
    filesystemScope: await filesystemCheck({ cwd, changedFiles, before, after }),
  };
  const errorSummary =
    execution.code === 0 ? "" : safeErrorSummary(execution.stderr);
  if (errorSummary) {
    process.stderr.write(`SDD_COMMAND_ERROR ${spec.name}\n${errorSummary}\n`);
  }
  const result = {
    ...verification,
    pass: verification.pass && Object.values(runtimeChecks).every(Boolean),
    startedAt,
    completedAt: new Date().toISOString(),
    runtimeChecks,
    fixture: cwd,
    changedFiles,
    command: {
      exitCode: execution.code,
      timedOut: execution.timedOut,
      schemaMismatch: /reserved .*schema mismatch|HTTP 400/i.test(
        `${execution.stdout}\n${execution.stderr}`,
      ),
      errorSummary,
    },
  };
  try {
    result.cleanup = {
      pass: true,
      ...(await cleanupProbeArtifacts([probeHome])),
    };
  } catch (error) {
    result.cleanup = {
      pass: false,
      errorSummary: safeErrorSummary(error.message),
    };
  }
  result.runtimeChecks.temporaryArtifactsCleaned = result.cleanup.pass;
  result.pass = result.pass && result.cleanup.pass;
  result.completedAt = new Date().toISOString();
  return result;
}

function sddMarkdown(report) {
  const rows = report.phases
    .map(
      (phase) =>
        `| ${phase.role} | ${phase.pass ? "PASS" : "FAIL"} | ${phase.actual?.model ?? "n/a"} | ${phase.actual?.effort ?? "n/a"} | ${phase.actual?.sandbox ?? "n/a"} |`,
    )
    .join("\n");
  return `# SDD Adapter Contract Probe\n\n- Generated: ${report.generatedAt}\n- Status: ${report.pass ? "PASS" : "FAIL"}\n- Execution: sequential permission-matched disposable phases\n- Global config unchanged: ${report.globalConfigUnchanged ? "yes" : "no"}\n- Codex core hook tested: no\n\n| Phase role | Status | Actual model | Effort | Sandbox |\n|---|---|---|---|---|\n${rows}\n`;
}

async function runSddAdapterProbe({ writeReport = true } = {}) {
  const runtimeBinding = await collectRuntimeBinding();
  if (!runtimeBinding.git.clean) {
    throw new Error(
      "Paid SDD adapter probe requires a clean Git tree so its evidence is immutable",
    );
  }
  const globalConfigPath = join(CODEX_HOME, "config.toml");
  const globalConfigBefore = await readOptional(globalConfigPath);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-sdd-"));
  const workerCwd = join(fixtureRoot, "worker");
  const reviewerCwd = join(fixtureRoot, "reviewer");
  await mkdir(workerCwd, { recursive: true });
  await writeFile(join(workerCwd, "worker-target.txt"), "BEFORE\n", "utf8");

  const phases = [];
  let workerResult = null;
  let reviewerResult = null;
  let cleanup = { pass: false };
  try {
    const workerSpec = ROLE_SPECS.find((spec) => spec.name === "terra_worker");
    const workerMarker = "SDD_WORKER_OK:AFTER";
    workerResult = await runSddTypedPhase({
      spec: workerSpec,
      cwd: workerCwd,
      task: [
        "This is the bounded implementer phase of a disposable subagent-driven-development adapter contract.",
        "Use apply_patch to change only worker-target.txt from BEFORE to AFTER.",
        "Verify the exact final content, do not touch any other file, and do not spawn another agent.",
        `Return ${workerMarker} in the final response.`,
      ].join(" "),
      marker: workerMarker,
      filesystemCheck: async ({ cwd, changedFiles }) =>
        changedFiles.length === 1 &&
        changedFiles[0] === "worker-target.txt" &&
        (await readFile(join(cwd, "worker-target.txt"), "utf8")) === "AFTER\n",
    });
    phases.push(workerResult);

    if (workerResult.pass) {
      await mkdir(reviewerCwd, { recursive: true });
      const finalState = await readFile(join(workerCwd, "worker-target.txt"), "utf8");
      await writeFile(join(reviewerCwd, "review.diff"), "-BEFORE\n+AFTER\n", "utf8");
      await writeFile(join(reviewerCwd, "final-state.txt"), finalState, "utf8");
      await writeFile(
        join(reviewerCwd, "acceptance.txt"),
        "Only worker-target.txt changes from BEFORE to AFTER.\n",
        "utf8",
      );
      const reviewerSpec = ROLE_SPECS.find((spec) => spec.name === "sol_reviewer");
      const reviewerMarker = "SDD_REVIEW_OK:AFTER";
      reviewerResult = await runSddTypedPhase({
        spec: reviewerSpec,
        cwd: reviewerCwd,
        task: [
          "This is the read-only task-review phase of a disposable subagent-driven-development adapter contract.",
          "Read acceptance.txt, review.diff, and final-state.txt.",
          "Confirm the diff matches the acceptance contract and the final state is exactly AFTER.",
          "Do not edit or create files and do not spawn another agent.",
          `Return ${reviewerMarker} in the final response.`,
        ].join(" "),
        marker: reviewerMarker,
        filesystemCheck: async ({ changedFiles }) => changedFiles.length === 0,
      });
      phases.push(reviewerResult);
    }
  } finally {
    try {
      cleanup = {
        pass: true,
        ...(await cleanupProbeArtifacts([fixtureRoot])),
      };
    } catch (error) {
      cleanup = { pass: false, errorSummary: safeErrorSummary(error.message) };
    }
  }

  const globalConfigAfter = await readOptional(globalConfigPath);
  const runtimeBindingAfter = await collectRuntimeBinding();
  const sequenceChecks = {
    workerCompletedBeforeReview:
      Boolean(workerResult?.completedAt) &&
      Boolean(reviewerResult?.startedAt) &&
      Date.parse(workerResult.completedAt) <= Date.parse(reviewerResult.startedAt),
    workerChangedOnlyTarget: workerResult?.runtimeChecks?.filesystemScope === true,
    reviewerObservedFinalState: reviewerResult?.checks?.markerReturned === true,
    reviewerChangedNoFiles:
      reviewerResult?.runtimeChecks?.filesystemScope === true &&
      reviewerResult?.changedFiles?.length === 0,
  };
  const report = {
    schemaVersion: 1,
    kind: "sdd_adapter_contract",
    generatedAt: new Date().toISOString(),
    pass:
      phases.length === 2 &&
      phases.every((phase) => phase.pass) &&
      Object.values(sequenceChecks).every(Boolean) &&
      globalConfigAfter === globalConfigBefore &&
      runtimeBinding.sha256 === runtimeBindingAfter.sha256 &&
      cleanup.pass,
    globalConfigUnchanged: globalConfigAfter === globalConfigBefore,
    globalConfigBeforeSha256:
      globalConfigBefore === null ? null : sha256(globalConfigBefore),
    globalConfigAfterSha256:
      globalConfigAfter === null ? null : sha256(globalConfigAfter),
    runtimeBinding,
    runtimeBindingAfterSha256: runtimeBindingAfter.sha256,
    runtimeBindingStable: runtimeBinding.sha256 === runtimeBindingAfter.sha256,
    phases,
    sequenceChecks,
    cleanup,
    boundary: {
      workflow: "superpowers:subagent-driven-development",
      verification: "adapter_contract",
      codexCoreHookTested: false,
      permissionStrategy: "sequential_isolated_roots",
    },
  };
  const validation = validateSddAdapterEvidence(report);
  report.pass = report.pass && validation.pass;
  report.validationChecks = validation.checks;
  if (writeReport) {
    const directory = join(REPO_ROOT, "reports", `${timestamp()}-sdd`);
    await mkdir(directory, { recursive: true });
    await writeJson(join(directory, "sdd.json"), report);
    await atomicWrite(join(directory, "sdd.md"), sddMarkdown(report));
    report.reportDirectory = directory;
  }
  return report;
}

function smokeMarkdown(report) {
  const rows = report.roles
    .map((item) => {
      const parentTokens = item.actual?.parentTokenUsage?.total_tokens ?? "n/a";
      const childTokens = item.actual?.tokenUsage?.total_tokens ?? "n/a";
      return `| ${item.role} | ${item.pass ? "PASS" : "FAIL"} | ${item.actual?.model ?? "n/a"} | ${item.actual?.effort ?? "n/a"} | ${item.actual?.sandbox ?? "n/a"} | ${parentTokens} | ${childTokens} |`;
    })
    .join("\n");
  return `# Gearbox V2 Role Smoke\n\n- Generated: ${report.generatedAt}\n- Status: ${report.pass ? "PASS" : "FAIL"}\n- Root runtime: ${report.rootRuntime.model} / ${report.rootRuntime.effort} (${report.rootRuntime.verified ? "verified" : "unverified"})\n- Global config unchanged: ${report.globalConfigUnchanged ? "yes" : "no"}\n- Policy: no retries; stop on first failure\n\n| Role | Status | Actual model | Effort | Sandbox | Parent tokens | Child tokens |\n|---|---|---|---|---|---:|---:|\n${rows}\n`;
}

async function runSmokeAll({ writeReport = true } = {}) {
  const runtimeBinding = await collectRuntimeBinding();
  if (!runtimeBinding.git.clean) {
    throw new Error(
      "Paid smoke requires a clean Git tree so its evidence can be bound and reused",
    );
  }
  const globalConfigPath = join(CODEX_HOME, "config.toml");
  const globalConfigBefore = await readOptional(globalConfigPath);
  const roles = [];
  for (const spec of ROLE_SPECS.filter((role) => role.smoke)) {
    process.stdout.write(`SMOKE_START ${spec.name}\n`);
    const result = await runRoleProbe(spec);
    roles.push(result);
    process.stdout.write(`SMOKE_${result.pass ? "PASS" : "FAIL"} ${spec.name}\n`);
    if (!result.pass) break;
  }
  const globalConfigAfter = await readOptional(globalConfigPath);
  const runtimeBindingAfter = await collectRuntimeBinding();
  const globalConfigUnchanged = globalConfigAfter === globalConfigBefore;
  const runtimeBindingStable =
    runtimeBinding.sha256 === runtimeBindingAfter.sha256;
  if (!globalConfigUnchanged) {
    process.stdout.write("SMOKE_FAIL global_config_changed\n");
  }
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    pass:
      roles.length === ROLE_SPECS.filter((role) => role.smoke).length &&
      roles.every((item) => item.pass) &&
      globalConfigUnchanged &&
      runtimeBindingStable,
    expectedRoleCount: ROLE_SPECS.filter((role) => role.smoke).length,
    rootRuntime: {
      model: SMOKE_ROOT.model,
      effort: SMOKE_ROOT.effort,
      verified:
        roles.length === ROLE_SPECS.filter((role) => role.smoke).length &&
        roles.every(
          (item) =>
            item.checks.parentModelMatches &&
            item.checks.parentEffortMatches,
        ),
    },
    globalConfigUnchanged,
    globalConfigBeforeSha256:
      globalConfigBefore === null ? null : sha256(globalConfigBefore),
    globalConfigAfterSha256:
      globalConfigAfter === null ? null : sha256(globalConfigAfter),
    runtimeBinding,
    runtimeBindingAfterSha256: runtimeBindingAfter.sha256,
    runtimeBindingStable,
    roles,
  };
  if (writeReport) {
    const directory = join(REPO_ROOT, "reports", `${timestamp()}-smoke`);
    await mkdir(directory, { recursive: true });
    await writeJson(join(directory, "smoke.json"), report);
    await atomicWrite(join(directory, "smoke.md"), smokeMarkdown(report));
    report.reportDirectory = directory;
  }
  return report;
}

function acceptanceMarkdown(report) {
  const rows = report.questions.map((question) =>
    `| ${question.id} | ${question.pass ? "PASS" : "FAIL"} | ${question.selectedShape} | ${question.reasonCode} | ${question.runtime ? "yes" : "no"} | ${question.cleanup.pass ? "yes" : "no"} |`,
  ).join("\n");
  return `# Gearbox V2 Acceptance Exam\n\n- Generated: ${report.generatedAt}\n- Status: ${report.pass ? "PASS" : "FAIL"}\n- Activation eligible: ${report.activationEligible ? "yes" : "no"}\n- Runtime binding stable: ${report.runtimeBindingStable ? "yes" : "no"}\n- Global config unchanged: ${report.globalConfigUnchanged ? "yes" : "no"}\n\n| Question | Status | Shape | Reason | Persisted runtime | Cleanup |\n|---|---|---|---|---|---|\n${rows}\n`;
}

async function runAcceptanceAll({ roleSmoke = null } = {}) {
  const doctor = await runDoctor();
  if (!doctor.pass) throw new Error("Preflight doctor failed");
  const modelCache = JSON.parse(await readFile(join(CODEX_HOME, "models_cache.json"), "utf8"));
  const sol = modelCache.models?.find((model) => model.slug === "gpt-5.6-sol");
  if (!(sol?.supported_reasoning_levels ?? []).some((level) => level.effort === "ultra")) {
    throw new Error("Model catalog does not support gpt-5.6-sol / ultra");
  }
  const runtimeBinding = await collectRuntimeBinding();
  if (!runtimeBinding.git.clean) throw new Error("Acceptance requires a clean Git tree");
  const smoke = roleSmoke ?? await runSmokeAll();
  if (!smoke.pass) throw new Error("Acceptance requires current six-role smoke evidence");
  const report = await runAcceptanceExam({
    policy: { allowTypedBridge: false },
    roleSmoke: smoke,
    runtimeBinding,
    collectRuntimeBinding,
    readGlobalConfig: () => readFile(join(CODEX_HOME, "config.toml"), "utf8"),
    executeRoot: runAcceptanceRoot,
    executeIsolated: runAcceptanceIsolated,
    executeTyped: async (scenario, { decision }) => {
      const worker = smoke.roles?.find((role) => role.role === "terra_worker");
      return acceptanceResult(scenario, {
        decision,
        pass: worker?.pass === true,
        runtime: { persisted: worker?.checks?.parentPersisted === true && worker?.checks?.childPersisted === true, model: worker?.actual?.model, effort: worker?.actual?.effort, tokenUsage: worker?.actual?.tokenUsage ?? null },
        cleanup: { pass: worker?.cleanup?.pass === true },
      });
    },
    executeParallel: runAcceptanceParallel,
    planScenario: (scenario) => planAcceptanceScenario({
      scenario,
      policy: { mode: "active", allowTypedBridge: false },
      capabilities: { agentTypeVisible: true, runtimeMetadataAvailable: true, bridgeRuntimeVerified: false, permissionBypassActive: false },
      roleSpecs: ROLE_SPECS,
    }),
    onQuestion: (question) => process.stdout.write(`QUESTION ${question.id} ${question.pass ? "PASS" : "FAIL"}\n`),
  });
  const directory = join(REPO_ROOT, "reports", `${timestamp()}-acceptance`);
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "acceptance.json"), report);
  await atomicWrite(join(directory, "acceptance.md"), acceptanceMarkdown(report));
  return attachAcceptanceMetadata(report, { reportDirectory: directory });
}

async function postInstallRootSmoke({ requireUltra = false } = {}) {
  const marker = "GLOBAL_V2_ROOT_OK";
  const startedAtMs = Date.now();
  const result = await runCommand(
    CODEX_BIN,
    [
      "--strict-config",
      "-s",
      "read-only",
      "-a",
      "never",
      "-C",
      REPO_ROOT,
      "exec",
      "--json",
      "--skip-git-repo-check",
      `Do not call any tool or spawn any agent. Reply exactly ${marker}.`,
    ],
    { timeoutMs: 600_000 },
  );
  const summary = await singleRootSummary(join(CODEX_HOME, "sessions"), REPO_ROOT, startedAtMs);
  const runtime = acceptanceRuntime(summary);
  const runtimeMatches = !requireUltra || (runtime.model === "gpt-5.6-sol" && runtime.effort === "ultra");
  return {
    pass:
      result.code === 0 &&
      !result.timedOut &&
      result.stdout.includes(marker) &&
      runtime.persisted &&
      runtimeMatches &&
      !/reserved .*schema mismatch|HTTP 400/i.test(
        `${result.stdout}\n${result.stderr}`,
      ),
    exitCode: result.code,
    timedOut: result.timedOut,
    markerReturned: result.stdout.includes(marker),
    schemaMismatch: /reserved .*schema mismatch|HTTP 400/i.test(
      `${result.stdout}\n${result.stderr}`,
    ),
    actual: runtime,
    requiredRuntime: requireUltra ? { model: "gpt-5.6-sol", effort: "ultra" } : null,
  };
}

async function rollbackFromManifest(manifestPath, { force = false, reason = null } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.status === "rolled_back" || manifest.status === "failed_rolled_back") {
    return manifest;
  }
  const configPath = manifest.config.path;
  const agentsPath = manifest.agents.path;
  const currentConfig = await readFile(configPath, "utf8");
  const currentAgents = await readFile(agentsPath, "utf8");
  if (!force && manifest.config.afterSha256 && sha256(currentConfig) !== manifest.config.afterSha256) {
    throw new Error("config.toml changed after installation; refusing rollback without --force");
  }
  if (!force && manifest.agents.afterSha256 && sha256(currentAgents) !== manifest.agents.afterSha256) {
    throw new Error("AGENTS.md changed after installation; refusing rollback without --force");
  }
  const dispatchEntries = manifest.files.filter((entry) => entry.kind?.startsWith("dispatch-"));
  for (const entry of manifest.files) {
    if (force || !entry.afterSha256) continue;
    const metadata = await lstat(entry.targetPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`managed file is no longer a regular file: ${entry.targetPath}`);
    }
    if (entry.mode !== undefined && (metadata.mode & 0o777) !== entry.mode) {
      throw new Error(`managed file mode changed after installation: ${entry.targetPath}`);
    }
    const current = await readOptional(entry.targetPath);
    if (current === null || sha256(current) !== entry.afterSha256) {
      throw new Error(`managed file changed after installation: ${entry.targetPath}`);
    }
  }

  await atomicWrite(
    configPath,
    rollbackConfig(currentConfig),
    manifest.config.mode ?? 0o600,
  );
  const actions = [];
  actions.push(
    await restoreBackup(manifest.agents.backup, manifest.timestamp),
  );
  for (const entry of manifest.files) {
    if (entry.kind?.startsWith("dispatch-")) continue;
    if (entry.removeOnRollback && !entry.backup.existed) {
      try {
        await unlink(entry.targetPath);
        actions.push({ path: entry.targetPath, action: "removed" });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        actions.push({ path: entry.targetPath, action: "already_absent" });
      }
    } else {
      actions.push(await restoreBackup(entry.backup, manifest.timestamp));
    }
  }
  if (dispatchEntries.length > 0) {
    await rollbackDispatchRuntime({
      manifest: { codexHome: CODEX_HOME, files: dispatchEntries },
      force: true,
    });
    actions.push({ path: join(CODEX_HOME, "gearbox", "runtime"), action: "dispatch_runtime_restored" });
  }
  manifest.status = reason ? "failed_rolled_back" : "rolled_back";
  manifest.rollback = {
    at: new Date().toISOString(),
    reason,
    actions,
  };
  await writeJson(manifestPath, manifest);
  return manifest;
}

async function readManagedPolicyTarget(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("unmanaged dispatch policy target must be a regular file");
  }
  const source = await readFile(path, "utf8");
  return assertManagedPolicyTarget(source);
}

async function installAfterSmoke(smoke, { dispatchMode = null, acceptance = null } = {}) {
  if (dispatchMode !== null && !["shadow", "active"].includes(dispatchMode)) {
    throw new Error("dispatch mode must be shadow or active");
  }
  const runTimestamp = timestamp();
  const reportDirectory = join(REPO_ROOT, "reports", `${runTimestamp}-apply`);
  const manifestPath = join(reportDirectory, "install-manifest.json");
  const installId = `gearbox-${runTimestamp}`;
  if (dispatchMode === "active") {
    const trusted = validateTrustedAcceptance({
      report: acceptance,
      currentBinding: await collectRuntimeBinding(),
      reportFile: { pathConfined: true, regular: true, symlink: false },
    });
    if (!trusted.pass) throw new Error("active dispatch requires trusted acceptance evidence");
  }
  const policy = dispatchMode === null ? null : createDispatchPolicy(
    dispatchMode === "active"
      ? { mode: "active", allowTypedBridge: false, activation: { installId, manifestPath } }
      : { mode: "shadow", allowTypedBridge: false, activation: null },
  );
  const policySource = policy === null ? null : serializeDispatchPolicy(policy);
  const policyTarget = join(CODEX_HOME, DISPATCH_POLICY_RELATIVE_PATH);
  if (policySource !== null) await readManagedPolicyTarget(policyTarget);
  const backupDirectory = join(
    CODEX_HOME,
    "backups",
    "sol-ultra-gearbox-v2",
    runTimestamp,
  );
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });

  const configPath = join(CODEX_HOME, "config.toml");
  const agentsPath = join(CODEX_HOME, "AGENTS.md");
  const launcherPath = join(CODEX_HOME, "bin", "codex-typed-agent");
  const configSource = await readFile(configPath, "utf8");
  const agentsSource = await readFile(agentsPath, "utf8");
  const configTarget = renderConfig(configSource, CODEX_HOME, { promoteV2: true });
  const agentsTarget = renderAgentsMd(agentsSource);
  const configMode = (await stat(configPath)).mode & 0o777;
  const agentsMode = (await stat(agentsPath)).mode & 0o777;

  const agentsBackup = await backupFile(agentsPath, backupDirectory);
  const fileEntries = [];
  for (const spec of ROLE_SPECS) {
    const target = installedRolePath(spec);
    const backup = await backupFile(target, backupDirectory);
    const source = await readFile(rolePath(spec), "utf8");
    fileEntries.push({
      kind: "role",
      role: spec.name,
      sourcePath: rolePath(spec),
      targetPath: target,
      afterSha256: sha256(source),
      backup,
    });
  }
  const launcherBackup = await backupFile(launcherPath, backupDirectory);
  const launcherSource = await readFile(join(REPO_ROOT, "scripts", "codex-typed-agent"), "utf8");
  fileEntries.push({
    kind: "launcher",
    sourcePath: join(REPO_ROOT, "scripts", "codex-typed-agent"),
    targetPath: launcherPath,
    afterSha256: sha256(launcherSource),
    sourceSha256: sha256(launcherSource),
    targetSha256: sha256(launcherSource),
    mode: 0o755,
    backup: launcherBackup,
  });
  let dispatchInstall = null;
  if (policySource !== null) {
    dispatchInstall = await installDispatchRuntime({
      sourceRoot: REPO_ROOT,
      codexHome: CODEX_HOME,
      backupDirectory,
      dispatchMode,
      dispatchPolicy: policy,
    });
    fileEntries.push(...dispatchInstall.files);
  }

  const manifest = {
    schemaVersion: 1,
    timestamp: runTimestamp,
    generatedAt: new Date().toISOString(),
    status: "applying",
    smokeReportDirectory: smoke.reportDirectory ?? null,
    smokeEvidence: smoke.reuse ?? { mode: "fresh_smoke" },
    activation: dispatchMode === "active" ? {
      installId,
      manifestPath,
      repositoryRoot: REPO_ROOT,
      policySha256: policy.sha256,
      acceptanceBindingSha256: acceptance.runtimeBinding.sha256,
    } : null,
    config: {
      path: configPath,
      beforeSha256: sha256(configSource),
      afterSha256: sha256(configTarget),
      mode: configMode,
      managedMarkers: [
        CONFIG_LEGACY_THREADS_MARKER,
        CONFIG_ROLES_MARKER,
        CONFIG_V2_MARKER,
      ],
    },
    agents: {
      path: agentsPath,
      beforeSha256: sha256(agentsSource),
      afterSha256: sha256(agentsTarget),
      mode: agentsMode,
      managedMarker: AGENTS_MARKER,
      backup: agentsBackup,
    },
    files: fileEntries,
  };

  let manifestPersisted = false;
  try {
    await writeJson(manifestPath, manifest);
    manifestPersisted = true;
    for (const entry of fileEntries) {
      if (entry.kind.startsWith("dispatch-")) continue;
      const source = entry.kind === "dispatch-policy"
        ? policySource
        : await readFile(entry.sourcePath, "utf8");
      await atomicWrite(
        entry.targetPath,
        source,
        entry.mode ?? (entry.kind === "launcher" ? 0o755 : 0o644),
      );
    }
    await atomicWrite(agentsPath, agentsTarget, agentsMode);
    await atomicWrite(configPath, configTarget, configMode);

    const strict = await runCommand(CODEX_BIN, ["--strict-config", "--version"]);
    const doctor = await runCommand(CODEX_BIN, ["doctor", "--json"], {
      timeoutMs: 120_000,
    });
    const doctorJson = parseJsonObject(doctor.stdout);
    const staticChecks = {
      strictConfig: strict.code === 0,
      configLoad: doctorJson?.checks?.["config.load"]?.status === "ok",
      mcpConfig: doctorJson?.checks?.["mcp.config"]?.status === "ok",
      installation: doctorJson?.checks?.installation?.status === "ok",
    };
    if (!Object.values(staticChecks).every(Boolean)) {
      throw new Error("Post-install static checks failed");
    }

    const rootSmoke = await postInstallRootSmoke({ requireUltra: dispatchMode === "active" });
    if (!rootSmoke.pass) throw new Error("Post-install fresh-root smoke failed");

    manifest.status = "applied";
    manifest.completedAt = new Date().toISOString();
    manifest.staticChecks = staticChecks;
    manifest.postInstallRootSmoke = rootSmoke;
    await writeJson(manifestPath, manifest);
    await atomicWrite(
      join(reportDirectory, "result.md"),
      `# Gearbox V2 Apply Result\n\n- Status: PASS\n- Manifest: ${manifestPath}\n- ${smoke.expectedRoleCount}-role smoke: PASS (${smoke.reuse ? "trusted recent evidence reused" : "fresh"})\n- Root runtime: ${smoke.rootRuntime.model} / ${smoke.rootRuntime.effort} (${smoke.rootRuntime.verified ? "verified" : "unverified"})\n- Post-install fresh-root smoke: PASS\n- Current tasks retain their original tool schema; restart Codex and open a new task.\n`,
    );
    return { manifestPath, manifest };
  } catch (error) {
    if (manifestPersisted) {
      await rollbackFromManifest(manifestPath, {
        force: true,
        reason: error.message,
      });
    } else if (dispatchInstall !== null) {
      await rollbackDispatchRuntime({ manifest: dispatchInstall, force: true });
    }
    throw error;
  }
}

async function cleanupSmokeProjects(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.status !== "applied") {
    throw new Error("cleanup requires an applied manifest");
  }
  const current = await readFile(manifest.config.path, "utf8");
  if (sha256(current) !== manifest.config.afterSha256) {
    throw new Error("config.toml drifted after apply; refusing cleanup");
  }
  const cleaned = removeOwnedSmokeProjectEntries(current);
  if (cleaned.paths.length === 0) {
    throw new Error("No Gearbox smoke project entries found");
  }
  const beforeSha256 = sha256(current);
  const afterSha256 = sha256(cleaned.source);
  await atomicWrite(
    manifest.config.path,
    cleaned.source,
    manifest.config.mode ?? 0o600,
  );
  manifest.config.appliedSha256 = beforeSha256;
  manifest.config.afterSha256 = afterSha256;
  manifest.config.managedMarkers = [
    CONFIG_LEGACY_THREADS_MARKER,
    CONFIG_ROLES_MARKER,
    CONFIG_V2_MARKER,
  ];
  manifest.postApplyCleanup = {
    at: new Date().toISOString(),
    removedSmokeProjectEntries: cleaned.paths,
    beforeSha256,
    afterSha256,
  };
  await writeJson(manifestPath, manifest);
  const resultPath = join(dirname(manifestPath), "result.md");
  const resultSource = await readOptional(resultPath);
  if (
    resultSource !== null &&
    !resultSource.includes("Smoke temp project entries cleaned")
  ) {
    await atomicWrite(
      resultPath,
      `${resultSource.trimEnd()}\n- Smoke temp project entries cleaned: ${cleaned.paths.length}; rollback hash updated.\n`,
    );
  }
  return manifest.postApplyCleanup;
}

export async function dryRunApply({ dispatchMode = null } = {}) {
  if (dispatchMode !== null && !["shadow", "active"].includes(dispatchMode)) {
    throw new Error("dispatch mode must be shadow or active");
  }
  const doctor = await runDoctor();
  const configPath = join(CODEX_HOME, "config.toml");
  const agentsPath = join(CODEX_HOME, "AGENTS.md");
  const configSource = await readFile(configPath, "utf8");
  const agentsSource = await readFile(agentsPath, "utf8");
  const configTarget = renderConfig(configSource, CODEX_HOME, { promoteV2: true });
  const agentsTarget = renderAgentsMd(agentsSource);
  const dispatch = dispatchMode === null ? null : (() => {
    const policy = dispatchMode === "active"
      ? createDispatchPolicy({ mode: "active", allowTypedBridge: false, activation: { installId: "preview", manifestPath: join(REPO_ROOT, "reports", "preview", "install-manifest.json") } })
      : createDispatchPolicy({ mode: "shadow", allowTypedBridge: false, activation: null });
    const policySource = serializeDispatchPolicy(policy);
    return {
      mode: policy.mode,
      policySha256: sha256(policySource),
      runtime: DISPATCH_RUNTIME_FILES.map((path) => ({ path, sha256: null })),
      wrapper: { path: "scripts/gearbox-dispatch", sha256: null },
      acceptanceRequired: dispatchMode === "active",
      acceptanceValidated: false,
    };
  })();
  if (dispatch !== null) {
    await readManagedPolicyTarget(join(CODEX_HOME, DISPATCH_POLICY_RELATIVE_PATH));
    for (const entry of dispatch.runtime) {
      entry.sha256 = sha256(await readFile(join(REPO_ROOT, entry.path), "utf8"));
    }
    dispatch.wrapper.sha256 = sha256(await readFile(join(REPO_ROOT, dispatch.wrapper.path), "utf8"));
  }
  return {
    pass: doctor.pass,
    doctor,
    changes: {
      config: {
        beforeSha256: sha256(configSource),
        afterSha256: sha256(configTarget),
        changed: configSource !== configTarget,
      },
      agents: {
        beforeSha256: sha256(agentsSource),
        afterSha256: sha256(agentsTarget),
        changed: agentsSource !== agentsTarget,
      },
      installedRoleCount: ROLE_SPECS.length,
      dispatch,
      secretsCopiedToReport: false,
    },
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function usage() {
  process.stderr.write(`Usage:
  node scripts/gearbox.mjs doctor [--json]
  node scripts/gearbox.mjs smoke --all
  node scripts/gearbox.mjs acceptance --all
  node scripts/gearbox.mjs smoke-sdd
  node scripts/gearbox.mjs apply --promote-v2 [--dry-run] [--dispatch-mode shadow|active] [--reuse-smoke <reports/.../smoke.json>] [--reuse-acceptance <reports/.../acceptance.json>]
  node scripts/gearbox.mjs cleanup-smoke-projects --manifest <path>
  node scripts/gearbox.mjs rollback --manifest <path> [--force]
`);
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exitCode = command ? 0 : 2;
    return;
  }

  if (command === "doctor") {
    const report = await runDoctor();
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(redactSensitive(report), null, 2)}\n`);
    } else {
      process.stdout.write(`GEARBOX_DOCTOR_${report.pass ? "PASS" : "FAIL"}\n`);
      for (const [name, pass] of Object.entries(report.checks)) {
        process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}\n`);
      }
    }
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "smoke") {
    if (!args.includes("--all")) throw new Error("smoke requires --all");
    const report = await runSmokeAll();
    process.stdout.write(`GEARBOX_SMOKE_${report.pass ? "PASS" : "FAIL"}\n`);
    process.stdout.write(`REPORT ${report.reportDirectory}\n`);
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "acceptance") {
    if (!args.includes("--all")) throw new Error("acceptance requires --all");
    const report = await runAcceptanceAll();
    process.stdout.write(`GEARBOX_ACCEPTANCE_${report.pass ? "PASS" : "FAIL"}\n`);
    process.stdout.write(`REPORT ${report.reportDirectory}\n`);
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "smoke-sdd") {
    const report = await runSddAdapterProbe();
    process.stdout.write(`GEARBOX_SDD_${report.pass ? "PASS" : "FAIL"}\n`);
    process.stdout.write(`REPORT ${report.reportDirectory}\n`);
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "apply") {
    if (!args.includes("--promote-v2")) {
      throw new Error("apply requires --promote-v2");
    }
    const dispatchMode = optionValue(args, "--dispatch-mode");
    if (args.includes("--dispatch-mode") && !dispatchMode) {
      throw new Error("--dispatch-mode requires a mode");
    }
    if (args.includes("--dry-run")) {
      const report = await dryRunApply({ dispatchMode });
      process.stdout.write(`${JSON.stringify(redactSensitive(report), null, 2)}\n`);
      if (!report.pass) process.exitCode = 1;
      return;
    }
    const doctor = await runDoctor();
    if (!doctor.pass) throw new Error("Preflight doctor failed");
    const reuseSmokePath = optionValue(args, "--reuse-smoke");
    if (args.includes("--reuse-smoke") && !reuseSmokePath) {
      throw new Error("--reuse-smoke requires a report path");
    }
    const smoke = reuseSmokePath
      ? await loadTrustedSmoke(reuseSmokePath)
      : await runSmokeAll();
    if (!smoke.pass) {
      throw new Error(
        `${smoke.expectedRoleCount}-role smoke failed; global config was not changed. Report: ${smoke.reportDirectory}`,
      );
    }
    const reuseAcceptancePath = optionValue(args, "--reuse-acceptance");
    if (args.includes("--reuse-acceptance") && !reuseAcceptancePath) {
      throw new Error("--reuse-acceptance requires a report path");
    }
    if (reuseAcceptancePath && dispatchMode !== "active") {
      throw new Error("--reuse-acceptance requires --dispatch-mode active");
    }
    const acceptance = dispatchMode === "active"
      ? (reuseAcceptancePath ? await loadTrustedAcceptance(reuseAcceptancePath) : await runAcceptanceAll({ roleSmoke: smoke }))
      : null;
    if (dispatchMode === "active" && !acceptance.pass) {
      throw new Error("Acceptance exam failed; global config was not changed");
    }
    const result = await installAfterSmoke(smoke, { dispatchMode, acceptance });
    process.stdout.write("GEARBOX_APPLY_PASS\n");
    process.stdout.write(`MANIFEST ${result.manifestPath}\n`);
    return;
  }

  if (command === "cleanup-smoke-projects") {
    const manifest = optionValue(args, "--manifest");
    if (!manifest) throw new Error("cleanup-smoke-projects requires --manifest");
    const result = await cleanupSmokeProjects(resolve(manifest));
    process.stdout.write("GEARBOX_CLEANUP_PASS\n");
    process.stdout.write(`${JSON.stringify(redactSensitive(result), null, 2)}\n`);
    return;
  }

  if (command === "rollback") {
    const manifest = optionValue(args, "--manifest");
    if (!manifest) throw new Error("rollback requires --manifest <path>");
    const result = await rollbackFromManifest(resolve(manifest), {
      force: args.includes("--force"),
    });
    process.stdout.write(`GEARBOX_ROLLBACK_${result.status.toUpperCase()}\n`);
    return;
  }

  usage();
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`GEARBOX_ERROR ${error.message}\n`);
    process.exitCode = 1;
  });
}
