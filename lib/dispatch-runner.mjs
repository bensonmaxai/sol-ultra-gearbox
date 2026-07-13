import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readlink, readdir, realpath, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  ROLE_SPECS,
  cleanupProbeArtifacts,
  findRecentRollouts,
  sha256,
  summarizeRollout,
  validateRoleText,
} from "./gearbox.mjs";
import { classifyDispatchFailure, verifyIsolatedRoot } from "./dispatch-evidence.mjs";

const ALLOWED_ROLE_NAMES = new Set(["luna_clerk", "terra_explorer"]);
const HASH = /^[a-f0-9]{64}$/;

function exactCheapReadRole(roleSpec) {
  const expected = ROLE_SPECS.find((role) => role.name === roleSpec?.name);
  return (
    expected &&
    ALLOWED_ROLE_NAMES.has(expected.name) &&
    expected.model === roleSpec.model &&
    expected.effort === roleSpec.effort &&
    expected.sandbox === roleSpec.sandbox
  );
}

export function parseRoleInstructions(source) {
  const starts = source.match(/^developer_instructions\s*=\s*"""/gm) ?? [];
  const matches = [...source.matchAll(/^developer_instructions\s*=\s*"""\r?\n([\s\S]*?)^"""[ \t]*\r?$/gm)];
  if (starts.length !== 1 || matches.length !== 1 || matches[0][1].trim().length === 0) {
    throw new TypeError("role source must contain exactly one complete developer_instructions multiline block");
  }
  return matches[0][1];
}

export function renderIsolatedPrompt({ instructions, task, marker, taskHash, roleHash }) {
  return [
    instructions.trim(),
    `Task packet hash: ${taskHash}`,
    `Role source hash: ${roleHash}`,
    task.trim(),
    `After the deliverable, append ${marker} on a separate final line only after completing the required checks.`,
    "Do not spawn, delegate, edit files, or broaden scope.",
  ].join("\n\n");
}

export function buildIsolatedRootArgs({ roleSpec, instructions, cwd, task, marker, taskHash = sha256(task), roleHash = sha256(instructions) }) {
  if (!exactCheapReadRole(roleSpec)) throw new TypeError("unsupported isolated root role");
  const prompt = renderIsolatedPrompt({ instructions, task, marker, taskHash, roleHash });
  return [
    "--strict-config",
    "-c", `model=${JSON.stringify(roleSpec.model)}`,
    "-c", `model_reasoning_effort=${JSON.stringify(roleSpec.effort)}`,
    "-c", 'plugins."superpowers@openai-curated".enabled=false',
    "-s", roleSpec.sandbox,
    "-a", "never",
    "-C", cwd,
    "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
    prompt,
  ];
}

function runCommand(command, args, { cwd, env, timeoutMs, timeoutGraceMs = 100 }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env, NO_COLOR: "1", TERM: "dumb" },
      stdio: "ignore",
    });
    let timedOut = false;
    let settled = false;
    let graceTimer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      graceTimer = setTimeout(() => child.kill("SIGKILL"), timeoutGraceMs);
    }, timeoutMs);
    child.on("error", (error) => {
      finish(rejectPromise, error);
    });
    child.on("close", (code) => {
      finish(resolvePromise, { code: code ?? -1, timedOut });
    });
  });
}

async function snapshotWorkspace(root) {
  const entries = {};
  async function visit(path) {
    const metadata = await lstat(path);
    const key = relative(root, path) || ".";
    const mode = metadata.mode & 0o7777;
    if (metadata.isSymbolicLink()) {
      entries[key] = { type: "symlink", mode, target: await readlink(path) };
      return;
    }
    if (metadata.isDirectory()) {
      entries[key] = { type: "directory", mode };
      const children = await readdir(path);
      for (const child of children.sort()) await visit(join(path, child));
      return;
    }
    if (metadata.isFile()) {
      entries[key] = { type: "file", mode, sha256: sha256(await readFile(path)) };
      return;
    }
    entries[key] = { type: "other", mode };
  }
  await visit(root);
  return entries;
}

function snapshotDiff(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => JSON.stringify(before[path]) !== JSON.stringify(after[path])).sort();
}

async function locateSingleRootRollout({ codexHome, cwd, sinceMs }) {
  try {
    const paths = await findRecentRollouts(join(codexHome, "sessions"), sinceMs);
    const roots = [];
    for (const path of paths) {
      const source = await readFile(path, "utf8");
      if (source.split(/\r?\n/).filter(Boolean).some((line) => {
        try { JSON.parse(line); return false; } catch { return true; }
      })) return null;
      const summary = await summarizeRollout(path);
      if (
        summary?.sessionMeta?.cwd === cwd &&
        typeof summary.threadSource === "string" &&
        summary.threadSource.length > 0 &&
        summary.threadSource !== "subagent"
      ) roots.push(summary);
    }
    return roots.length === 1 ? roots[0] : null;
  } catch {
    return null;
  }
}

async function physicalWorkspace(cwd) {
  const absolute = resolve(cwd);
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError("isolated runner requires a physical directory workspace");
  }
  const canonical = await realpath(absolute);
  return canonical;
}

function extractDeliverable(summary, marker) {
  for (const text of [...(summary?.finalTexts ?? [])].reverse()) {
    if (typeof text !== "string") continue;
    const lines = text.trimEnd().split(/\r?\n/);
    if (lines.at(-1) !== marker) continue;
    if (lines.slice(0, -1).some((line) => line.includes(marker))) continue;
    const deliverable = lines.slice(0, -1).join("\n").trim();
    if (deliverable.length > 0) return deliverable;
  }
  return null;
}

function failureEnvelope({ decision, roleSpec, roleHash, changedFiles, execution, cleanup }) {
  return verifyIsolatedRoot({
    summary: null,
    decision,
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles },
    cleanup: {
      passed: cleanup.passed,
      commandExitedZero: execution.code === 0,
      timedOut: execution.timedOut,
    },
  });
}

export async function runIsolatedRole({
  codexBin = "codex",
  codexHome,
  roleSpec,
  roleSource,
  cwd,
  task,
  taskHash,
  onDeliverable,
  runCommand: execute = runCommand,
  cleanupArtifacts = cleanupProbeArtifacts,
  timeoutMs = 600_000,
  env = {},
}) {
  if (!exactCheapReadRole(roleSpec)) throw new TypeError("unsupported isolated root role");
  const validation = validateRoleText(roleSpec, roleSource);
  if (!validation.pass) throw new TypeError("invalid isolated role source");
  const instructions = parseRoleInstructions(roleSource);
  if (!HASH.test(taskHash ?? "") || taskHash !== sha256(task)) {
    throw new TypeError("invalid task hash");
  }
  if (typeof onDeliverable !== "function") throw new TypeError("isolated runner requires onDeliverable");
  const safeCwd = await physicalWorkspace(cwd);

  const roleHash = sha256(roleSource);
  const marker = `ISOLATED_ROOT_OK:${taskHash.slice(0, 16)}`;
  const decision = {
    selectedShape: "isolated_role_root",
    role: roleSpec.name,
    reasonCode: "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH",
    taskHash,
    roleHash,
  };
  const before = await snapshotWorkspace(safeCwd);
  const fixture = await mkdtemp(join(tmpdir(), `sol-ultra-gearbox-v2-dispatch-${roleSpec.name}-`));
  let isolatedHome;
  try {
    isolatedHome = await mkdtemp(join(tmpdir(), `sol-ultra-gearbox-v2-dispatch-home-${roleSpec.name}-`));
  } catch (error) {
    await cleanupArtifacts([fixture]);
    throw error;
  }
  const authLink = join(isolatedHome, "auth.json");
  let after = before;
  let snapshotFailed = false;
  let execution = { code: -1, timedOut: false };
  let summary = null;
  let cleanup = { passed: false };

  try {
    const auth = join(codexHome, "auth.json");
    const metadata = await lstat(auth);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new TypeError("isolated runner requires fixture auth.json");
    await symlink(auth, authLink);
    const startedAtMs = Date.now();
    const args = buildIsolatedRootArgs({
      roleSpec,
      instructions,
      cwd: safeCwd,
      task,
      marker,
      taskHash,
      roleHash,
    });
    try {
      execution = await execute(codexBin, args, {
        cwd: safeCwd,
        timeoutMs,
        env: { ...env, CODEX_HOME: isolatedHome },
      });
    } catch {
      execution = { code: -1, timedOut: false };
    }
    summary = await locateSingleRootRollout({ codexHome: isolatedHome, cwd: safeCwd, sinceMs: startedAtMs });
  } finally {
    try {
      after = await snapshotWorkspace(safeCwd);
    } catch {
      snapshotFailed = true;
    }
    let authUnlinked = true;
    try {
      await unlink(authLink);
    } catch (error) {
      authUnlinked = error?.code === "ENOENT";
    }
    try {
      const removed = await cleanupArtifacts([isolatedHome, fixture]);
      cleanup = { passed: authUnlinked && removed.removed.length === 2 };
    } catch {
      cleanup = { passed: false };
    }
  }

  const changedFiles = snapshotFailed ? ["<workspace-snapshot-failed>"] : snapshotDiff(before, after);
  const result = summary
    ? verifyIsolatedRoot({
        summary,
        decision,
        roleSpec,
        roleHash,
        before: { changedFiles: [] },
        after: { changedFiles },
        cleanup: {
          passed: cleanup.passed,
          commandExitedZero: execution.code === 0,
          timedOut: execution.timedOut,
        },
      })
    : failureEnvelope({ decision, roleSpec, roleHash, changedFiles, execution, cleanup });
  const deliverable = result.pass ? extractDeliverable(summary, marker) : null;
  let deliveryAccepted = false;
  if (deliverable !== null) {
    try {
      deliveryAccepted = (await onDeliverable(deliverable)) === true;
    } catch {
      deliveryAccepted = false;
    }
  }
  result.checks.deliverableValid =
    result.checks.deliverableValid === true && deliverable !== null && deliveryAccepted;
  result.pass = Object.values(result.checks).every((value) => value === true);
  result.rollbackRequired = classifyDispatchFailure(result).rollbackRequired;
  return result;
}
