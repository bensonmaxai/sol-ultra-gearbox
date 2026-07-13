import { createHash } from "node:crypto";

export const EXECUTION_SHAPES = Object.freeze([
  "typed_child",
  "isolated_role_root",
  "typed_child_bridge",
  "root_inline",
]);

export const KNOWN_ADAPTERS = Object.freeze([
  "direct",
  "superpowers:subagent-driven-development",
  "superpowers:dispatching-parallel-agents",
  "superpowers:requesting-code-review",
  "codex-security:security-scan",
  "codex-security:security-diff-scan",
]);

export const RESPONSIBILITY_ROLES = Object.freeze({
  mechanical: "luna_clerk",
  exploration: "terra_explorer",
  implementation: "terra_worker",
  review: "sol_reviewer",
});

const HASH = /^[a-f0-9]{64}$/;
const PERMISSIONS = new Set(["read-only", "workspace-write"]);
const READ_ONLY_ISOLATED = new Set(["luna_clerk", "terra_explorer"]);
const OPT_IN = new Set(["terra_max_worker", "terra_ultra_specialist"]);
const PACKET_KEYS = new Set([
  "schemaVersion",
  "workflowAdapter",
  "responsibility",
  "goal",
  "readScope",
  "writeScope",
  "knownFacts",
  "constraints",
  "deliverable",
  "successCriteria",
  "checks",
  "prohibitedActions",
  "parentPermission",
  "requiredPermission",
  "requiresNativeLineage",
  "requestedRole",
  "ownerOptIn",
  "legacyAdapter",
  "batch",
  "riskSignals",
  "costSignals",
]);
const LIST_FIELDS = [
  "readScope",
  "writeScope",
  "knownFacts",
  "constraints",
  "successCriteria",
  "checks",
  "prohibitedActions",
];
const RISK_KEYS = ["ambiguous", "hiddenCoupling", "highRisk", "weakVerification"];
const COST_BOOLEAN_KEYS = [
  "oneLocation",
  "packagingDominates",
  "directlyConsumable",
  "includesRegressionTest",
];
const COST_NUMBER_KEYS = [
  "estimatedRootToolCalls",
  "repetitiveReads",
  "moduleCount",
  "fileCount",
  "bytes",
  "lines",
  "itemCount",
  "boundedFileCount",
];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function hashTaskPacket(packet) {
  return createHash("sha256")
    .update(JSON.stringify(stable(packet)))
    .digest("hex");
}

function section(label, value) {
  const lines = Array.isArray(value) ? value : [value];
  return `${label}:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

export function renderTaskMessage(packet) {
  return [
    section("Goal", packet.goal),
    section("Allowed read scope", packet.readScope),
    section(
      "Allowed write scope",
      packet.writeScope.length > 0 ? packet.writeScope : ["none"],
    ),
    section("Known facts", packet.knownFacts),
    section("Constraints", packet.constraints),
    section("Expected deliverable", packet.deliverable),
    section("Success criteria", packet.successCriteria),
    section("Required checks", packet.checks),
    section("Prohibited actions", packet.prohibitedActions),
  ].join("\n\n");
}

function hasExactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function validateTaskPacket(packet) {
  const errors = [];
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    return { pass: false, errors: ["packet must be an object"] };
  }

  for (const key of PACKET_KEYS) {
    if (!Object.hasOwn(packet, key)) errors.push(`missing ${key}`);
  }
  for (const key of Object.keys(packet)) {
    if (!PACKET_KEYS.has(key)) errors.push(`unrecognized ${key}`);
  }
  if (packet.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  for (const key of ["workflowAdapter", "responsibility", "goal", "deliverable"]) {
    if (typeof packet[key] !== "string" || packet[key].trim().length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  for (const key of LIST_FIELDS) {
    if (
      !Array.isArray(packet[key]) ||
      packet[key].some((item) => typeof item !== "string")
    ) {
      errors.push(`${key} must be an array of strings`);
    }
  }
  if (!PERMISSIONS.has(packet.parentPermission)) errors.push("invalid parentPermission");
  if (!PERMISSIONS.has(packet.requiredPermission)) errors.push("invalid requiredPermission");
  for (const key of ["requiresNativeLineage", "ownerOptIn", "legacyAdapter"]) {
    if (typeof packet[key] !== "boolean") errors.push(`${key} must be a boolean`);
  }
  if (!(packet.requestedRole === null || typeof packet.requestedRole === "string")) {
    errors.push("requestedRole must be a string or null");
  }
  if (!hasExactKeys(packet.batch, ["requestedChildren", "writerCount", "scopesDisjoint"])) {
    errors.push("batch must contain requestedChildren, writerCount, and scopesDisjoint");
  } else if (
    !isNonNegativeInteger(packet.batch.requestedChildren) ||
    !isNonNegativeInteger(packet.batch.writerCount) ||
    typeof packet.batch.scopesDisjoint !== "boolean"
  ) {
    errors.push("batch must contain non-negative integer counts and scopesDisjoint");
  }
  if (!hasExactKeys(packet.riskSignals, RISK_KEYS)) {
    errors.push("riskSignals must contain all risk flags");
  } else if (RISK_KEYS.some((key) => typeof packet.riskSignals[key] !== "boolean")) {
    errors.push("riskSignals must contain boolean flags");
  }
  const costKeys = [...COST_BOOLEAN_KEYS, ...COST_NUMBER_KEYS];
  if (!hasExactKeys(packet.costSignals, costKeys)) {
    errors.push("costSignals must contain all cost signals");
  } else if (
    COST_BOOLEAN_KEYS.some((key) => typeof packet.costSignals[key] !== "boolean") ||
    COST_NUMBER_KEYS.some((key) => !isNonNegativeInteger(packet.costSignals[key]))
  ) {
    errors.push("costSignals must contain boolean and non-negative integer values");
  }

  return { pass: errors.length === 0, errors };
}

function rootDecision(taskHash, policyMode, reasonCode, role = null) {
  return {
    schemaVersion: 1,
    taskHash,
    policyMode,
    selectedShape: "root_inline",
    effectiveShape: "root_inline",
    role,
    reasonCode,
    spawnArgs: null,
    requiresRuntimeEvidence: false,
  };
}

function costBenefitPasses(cost, responsibility) {
  if (cost.estimatedRootToolCalls <= 2 || cost.oneLocation || cost.packagingDominates) {
    return false;
  }
  if (!cost.directlyConsumable) return false;
  return (
    cost.repetitiveReads >= 3 ||
    cost.moduleCount >= 2 ||
    cost.fileCount >= 5 ||
    cost.bytes >= 102_400 ||
    cost.lines >= 500 ||
    cost.itemCount >= 20 ||
    (responsibility === "implementation" && cost.includesRegressionTest) ||
    (responsibility === "implementation" && cost.boundedFileCount >= 2)
  );
}

function findRoleSpec(roleSpecs, role) {
  if (!Array.isArray(roleSpecs)) return null;
  return (
    roleSpecs.find(
      (spec) =>
        spec &&
        typeof spec.name === "string" &&
        typeof spec.model === "string" &&
        typeof spec.effort === "string" &&
        PERMISSIONS.has(spec.sandbox) &&
        spec.name === role,
    ) ?? null
  );
}

export function planDispatch({ policy, packet, capabilities, roleSpecs }) {
  if (!policy || !["shadow", "active"].includes(policy.mode)) {
    throw new TypeError("planner requires a validated shadow or active policy");
  }
  const packetValidation = validateTaskPacket(packet);
  if (!packetValidation.pass) {
    throw new TypeError(`invalid task packet: ${packetValidation.errors.join("; ")}`);
  }

  const taskHash = hashTaskPacket(packet);
  if (!HASH.test(taskHash)) throw new TypeError("invalid task hash");
  if (!KNOWN_ADAPTERS.includes(packet.workflowAdapter)) {
    return rootDecision(taskHash, policy.mode, "ROOT_UNKNOWN_SKILL");
  }
  if (!capabilities?.agentTypeVisible) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCHEMA_UNAVAILABLE");
  }
  if (!capabilities.runtimeMetadataAvailable) {
    return rootDecision(taskHash, policy.mode, "ROOT_RUNTIME_EVIDENCE_FAILED");
  }
  if (capabilities.permissionBypassActive) {
    return rootDecision(taskHash, policy.mode, "ROOT_HIGH_RISK");
  }
  if (
    packet.batch.requestedChildren > 2 ||
    packet.batch.writerCount > 1 ||
    !packet.batch.scopesDisjoint ||
    (packet.responsibility === "implementation" && packet.batch.writerCount !== 1) ||
    (packet.responsibility !== "implementation" && packet.batch.writerCount !== 0)
  ) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS");
  }
  if (packet.riskSignals.ambiguous) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS");
  }
  if (packet.riskSignals.hiddenCoupling) {
    return rootDecision(taskHash, policy.mode, "ROOT_HIDDEN_COUPLING");
  }
  if (packet.riskSignals.highRisk) {
    return rootDecision(taskHash, policy.mode, "ROOT_HIGH_RISK");
  }
  if (packet.riskSignals.weakVerification) {
    return rootDecision(taskHash, policy.mode, "ROOT_WEAK_VERIFICATION");
  }
  if (packet.costSignals.estimatedRootToolCalls <= 2 || packet.costSignals.oneLocation) {
    return rootDecision(taskHash, policy.mode, "ROOT_TRIVIAL");
  }
  if (!costBenefitPasses(packet.costSignals, packet.responsibility)) {
    return rootDecision(taskHash, policy.mode, "ROOT_COST_GATE_FAILED");
  }

  const role = packet.requestedRole ?? RESPONSIBILITY_ROLES[packet.responsibility];
  const spec = findRoleSpec(roleSpecs, role);
  if (!role || !spec) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS");
  }
  if (OPT_IN.has(role) && !(packet.ownerOptIn || packet.legacyAdapter)) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS", role);
  }
  if (spec.sandbox !== packet.requiredPermission) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS", role);
  }

  let selectedShape;
  let reasonCode;
  if (packet.parentPermission === spec.sandbox) {
    selectedShape = "typed_child";
    reasonCode = "DELEGATE_TYPED_PERMISSION_MATCH";
  } else if (spec.sandbox === "workspace-write") {
    return rootDecision(
      taskHash,
      policy.mode,
      "ROOT_WRITER_PERMISSION_MISMATCH",
      role,
    );
  } else if (packet.requiresNativeLineage || role === "sol_reviewer") {
    if (!(policy.allowTypedBridge && capabilities.bridgeRuntimeVerified)) {
      return rootDecision(taskHash, policy.mode, "ROOT_BRIDGE_DISABLED", role);
    }
    selectedShape = "typed_child_bridge";
    reasonCode = "DELEGATE_BRIDGE_LINEAGE_REQUIRED";
  } else if (READ_ONLY_ISOLATED.has(role)) {
    selectedShape = "isolated_role_root";
    reasonCode = "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH";
  } else {
    return rootDecision(taskHash, policy.mode, "ROOT_BRIDGE_DISABLED", role);
  }

  return {
    schemaVersion: 1,
    taskHash,
    policyMode: policy.mode,
    selectedShape,
    effectiveShape: policy.mode === "active" ? selectedShape : "root_inline",
    role,
    reasonCode,
    spawnArgs:
      selectedShape === "typed_child"
        ? {
            agent_type: role,
            fork_turns: "none",
            message: renderTaskMessage(packet),
          }
        : null,
    requiresRuntimeEvidence: true,
  };
}
