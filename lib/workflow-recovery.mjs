import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validateDispatchPolicy } from "./dispatch-policy.mjs";
import { stableValue } from "./private-jsonl.mjs";
import {
  replayWorkflowRecords,
  validateWorkflowRecordSequence,
} from "./workflow-ledger.mjs";
import { hashWorkflowPlan } from "./workflow-plan.mjs";

const HASH = /^[a-f0-9]{64}$/;
const BINDING_FIELDS = Object.freeze([
  "planHash",
  "policyMode",
  "policyHash",
  "permissionHash",
  "workspaceHash",
]);
const CAPABILITY_FIELDS = Object.freeze([
  "agentTypeVisible",
  "isolatedRunnerVerified",
  "runtimeMetadataAvailable",
  "bridgeRuntimeVerified",
  "permissionBypassActive",
]);
const INCOMPLETE_STATES = new Set(["materializing", "running", "evidence_ready", "verified"]);

function canonicalHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, fields) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function safeScope(scope) {
  return typeof scope === "string"
    && scope.length > 0
    && !isAbsolute(scope)
    && !scope.includes("\\")
    && scope.split("/").every((part) => part && part !== "." && part !== "..");
}

function fingerprint(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
  };
}

function sameFingerprint(left, right) {
  const a = fingerprint(left);
  const b = fingerprint(right);
  return Object.keys(a).every((key) => a[key] === b[key]);
}

function metadata(path) {
  return lstatSync(path, { bigint: true });
}

function assertNoSymlinkToMissing(root, absolute) {
  const fromRoot = relative(root, absolute);
  let current = root;
  for (const part of fromRoot.split("/").filter(Boolean)) {
    current = join(current, part);
    let value;
    try {
      value = metadata(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (value.isSymbolicLink()) throw new TypeError("workflow scope must not contain symlinks");
  }
}

function fileEntry(root, path, before) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new TypeError("workflow file changed while opening");
    }
    const source = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = metadata(path);
    if (!sameFingerprint(before, afterDescriptor) || !sameFingerprint(before, afterPath)) {
      throw new TypeError("workflow file changed during snapshot");
    }
    return {
      path: relative(root, path).split("\\").join("/"),
      type: "file",
      mode: Number(before.mode & 0o7777n),
      sha256: sha256(source),
    };
  } finally {
    closeSync(descriptor);
  }
}

function visitSnapshot(root, path, entries) {
  const before = metadata(path);
  if (before.isSymbolicLink()) throw new TypeError("workflow scope must not contain symlinks");
  const key = relative(root, path).split("\\").join("/");
  let entry;
  if (before.isFile()) {
    entry = fileEntry(root, path, before);
  } else if (before.isDirectory()) {
    entry = { path: key, type: "directory", mode: Number(before.mode & 0o7777n), sha256: null };
    for (const child of readdirSync(path).sort()) visitSnapshot(root, join(path, child), entries);
    const after = metadata(path);
    if (!sameFingerprint(before, after)) throw new TypeError("workflow directory changed during snapshot");
  } else {
    throw new TypeError("workflow scope must contain only regular files and directories");
  }
  const prior = entries.get(key);
  if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) {
    throw new TypeError("workflow scope changed between overlapping snapshots");
  }
  entries.set(key, entry);
}

function workspaceSnapshot(plan, cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("workflow cwd is required");
  const requestedRoot = resolve(cwd);
  const rootMetadata = lstatSync(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TypeError("workflow cwd must be a real directory");
  }
  const root = realpathSync(requestedRoot);
  const scopes = new Map();
  for (const stage of plan.stages) {
    for (const scope of stage.readScope) {
      if (!safeScope(scope)) throw new TypeError("workflow scopes must be safe relative paths");
      const current = scopes.get(scope) ?? { read: false, write: false };
      current.read = true;
      scopes.set(scope, current);
    }
    for (const scope of stage.writeScope) {
      if (!safeScope(scope)) throw new TypeError("workflow scopes must be safe relative paths");
      const current = scopes.get(scope) ?? { read: false, write: false };
      current.write = true;
      scopes.set(scope, current);
    }
  }

  const entries = new Map();
  for (const [scope, usage] of [...scopes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const absolute = resolve(root, scope);
    const fromRoot = relative(root, absolute);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
      throw new TypeError("workflow scope escapes cwd");
    }
    assertNoSymlinkToMissing(root, absolute);
    let existed = true;
    try {
      metadata(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      existed = false;
      if (usage.read) throw new TypeError("workflow read scope is missing");
    }
    if (!existed) {
      assertNoSymlinkToMissing(root, absolute);
      try {
        metadata(absolute);
        throw new TypeError("workflow scope changed during snapshot");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      entries.set(scope, { path: scope, type: "missing", mode: null, sha256: null });
      continue;
    }
    try {
      visitSnapshot(root, absolute, entries);
    } catch (error) {
      if (error?.code === "ENOENT") throw new TypeError("workflow scope changed during snapshot");
      throw error;
    }
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function permissionFacts(plan, capabilities) {
  if (!exactKeys(capabilities, CAPABILITY_FIELDS) || CAPABILITY_FIELDS.some((field) => typeof capabilities[field] !== "boolean")) {
    throw new TypeError("workflow capabilities must contain the exact boolean facts");
  }
  return {
    capabilities: Object.fromEntries(CAPABILITY_FIELDS.map((field) => [field, capabilities[field]])),
    stages: plan.stages.map((stage) => ({
      id: stage.id,
      parentPermission: stage.parentPermission,
      requiredPermission: stage.requiredPermission,
      responsibility: stage.responsibility,
      requestedRole: stage.requestedRole,
    })),
  };
}

export function createWorkflowBinding({ plan, policy, capabilities, cwd }) {
  const policyValidation = validateDispatchPolicy(policy);
  if (!policyValidation.pass) throw new TypeError(`workflow policy is invalid: ${policyValidation.errors.join("; ")}`);
  const binding = {
    planHash: hashWorkflowPlan(plan),
    policyMode: policy.mode,
    policyHash: policy.sha256,
    permissionHash: canonicalHash(permissionFacts(plan, capabilities)),
    workspaceHash: canonicalHash(workspaceSnapshot(plan, cwd)),
  };
  if (!exactKeys(binding, BINDING_FIELDS) || [binding.planHash, binding.policyHash, binding.permissionHash, binding.workspaceHash].some((value) => !HASH.test(value))) {
    throw new TypeError("workflow binding is invalid");
  }
  return binding;
}

function failed(reasonCode) {
  return { pass: false, reasonCode };
}

function adoptedAttempt(stage) {
  return [...stage.attempts].reverse().find((attempt) => attempt.adopted === true) ?? null;
}

function artifactDrift(plan, state, currentArtifactHashes) {
  if (!currentArtifactHashes || typeof currentArtifactHashes !== "object" || Array.isArray(currentArtifactHashes)) return true;
  for (const planStage of plan.stages) {
    const stage = state.stages[planStage.id];
    const attempt = adoptedAttempt(stage);
    if (!attempt) continue;
    const recorded = new Map((attempt.artifacts ?? []).map((artifact) => [artifact.id, artifact.sha256]));
    for (const artifactId of planStage.outputArtifacts) {
      const expected = recorded.get(artifactId);
      if (!HASH.test(expected ?? "") || currentArtifactHashes[artifactId] !== expected) return true;
    }
  }
  return false;
}

function completedStage(stage) {
  return stage.state === "adopted"
    || (stage.state === "closed" && (stage.cancelled === true || stage.attempts.some((attempt) => attempt.adopted === true)));
}

export function resumeWorkflow({ plan, records, binding, currentArtifactHashes }) {
  const sequence = validateWorkflowRecordSequence(records);
  if (!sequence.pass) return failed("WORKFLOW_LEDGER_INVALID");
  let canonicalPlanHash;
  try {
    canonicalPlanHash = hashWorkflowPlan(plan);
  } catch {
    return failed("WORKFLOW_PLAN_HASH_MISMATCH");
  }
  if (!exactKeys(binding, BINDING_FIELDS) || !HASH.test(binding.planHash ?? "")
      || binding.planHash !== canonicalPlanHash || records[0].planHash !== canonicalPlanHash) {
    return failed("WORKFLOW_PLAN_HASH_MISMATCH");
  }
  let state;
  try {
    state = replayWorkflowRecords({ plan, records });
  } catch {
    return failed("WORKFLOW_LEDGER_INVALID");
  }
  if (!["active", "shadow"].includes(binding.policyMode) || !HASH.test(binding.policyHash ?? "")
      || binding.policyMode !== records[0].policyMode || binding.policyHash !== records[0].policyHash) {
    return failed("WORKFLOW_POLICY_DRIFT");
  }
  if (!HASH.test(binding.permissionHash ?? "") || binding.permissionHash !== records[0].permissionHash) {
    return failed("WORKFLOW_PERMISSION_DRIFT");
  }
  if (!HASH.test(binding.workspaceHash ?? "") || binding.workspaceHash !== records[0].workspaceHash) {
    return failed("WORKFLOW_WORKSPACE_DRIFT");
  }
  if (artifactDrift(plan, state, currentArtifactHashes)) return failed("WORKFLOW_ARTIFACT_DRIFT");
  if (Object.values(state.stages).some((stage) => INCOMPLETE_STATES.has(stage.state))) {
    return failed("WORKFLOW_INCOMPLETE_EXECUTION");
  }
  return {
    pass: true,
    state,
    remainingStageIds: plan.stages.filter((stage) => !completedStage(state.stages[stage.id])).map((stage) => stage.id),
    rerunStageIds: [],
  };
}
