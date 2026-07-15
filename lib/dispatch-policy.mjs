import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const DISPATCH_POLICY_RELATIVE_PATH = "gearbox/dispatch-policy.json";

const MANAGED_BY = "sol-ultra-gearbox-v2";
const MODES = new Set(["active", "shadow"]);
const POLICY_V1_FIELDS = new Set([
  "schemaVersion",
  "managedBy",
  "mode",
  "allowTypedBridge",
  "activation",
  "sha256",
]);
const POLICY_V2_FIELDS = new Set([...POLICY_V1_FIELDS, "rootProvider"]);
const ROOT_PROVIDER_FIELDS = new Set([
  "kind",
  "enabled",
  "transport",
  "protocolVersion",
  "launcherPath",
  "acceptanceBindingSha256",
]);
const ACTIVATION_COMMON_FIELDS = new Set(["installId"]);
const ACTIVATION_PATH_FIELDS = new Set(["recordPath", "manifestPath"]);
const SHA256 = /^[a-f0-9]{64}$/;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function integrityFields(policy) {
  const fields = {
    schemaVersion: policy.schemaVersion,
    managedBy: policy.managedBy,
    mode: policy.mode,
    allowTypedBridge: policy.allowTypedBridge,
    activation: policy.activation,
  };
  if (policy.schemaVersion === 2) fields.rootProvider = policy.rootProvider;
  return fields;
}

function integrityDigest(policy) {
  return createHash("sha256")
    .update(JSON.stringify(stable(integrityFields(policy))))
    .digest("hex");
}

function validateActivation(activation, errors) {
  if (!isPlainObject(activation)) {
    errors.push("activation must be an object");
    return;
  }
  for (const key of Object.keys(activation)) {
    if (!ACTIVATION_COMMON_FIELDS.has(key) && !ACTIVATION_PATH_FIELDS.has(key)) {
      errors.push(`activation has unsupported field: ${key}`);
    }
  }
  if (!Object.hasOwn(activation, "installId")) errors.push("activation missing installId");
  if (typeof activation.installId !== "string" || activation.installId.trim().length === 0) {
    errors.push("activation.installId must be a non-empty string");
  }
  const pathFields = [...ACTIVATION_PATH_FIELDS].filter((key) => Object.hasOwn(activation, key));
  if (pathFields.length !== 1) {
    errors.push("activation requires exactly one of recordPath or manifestPath");
    return;
  }
  const [pathField] = pathFields;
  if (typeof activation[pathField] !== "string" || !isAbsolute(activation[pathField])) {
    errors.push(`activation.${pathField} must be an absolute path`);
  }
}

function validateRootProvider(rootProvider, mode, errors) {
  if (!isPlainObject(rootProvider)) {
    errors.push("rootProvider must be an object");
    return;
  }
  for (const key of Object.keys(rootProvider)) {
    if (!ROOT_PROVIDER_FIELDS.has(key)) {
      errors.push(`rootProvider has unsupported field: ${key}`);
    }
  }
  for (const key of ROOT_PROVIDER_FIELDS) {
    if (!Object.hasOwn(rootProvider, key)) errors.push(`rootProvider missing ${key}`);
  }
  if (rootProvider.kind !== "app_server_root") {
    errors.push("rootProvider.kind must equal app_server_root");
  }
  if (typeof rootProvider.enabled !== "boolean") {
    errors.push("rootProvider.enabled must be a boolean");
  } else if (rootProvider.enabled !== (mode === "active")) {
    errors.push("rootProvider.enabled must match active policy mode");
  }
  if (rootProvider.transport !== "stdio") {
    errors.push("rootProvider.transport must equal stdio");
  }
  if (rootProvider.protocolVersion !== 1) {
    errors.push("rootProvider.protocolVersion must equal 1");
  }
  if (typeof rootProvider.launcherPath !== "string" ||
    !isAbsolute(rootProvider.launcherPath)) {
    errors.push("rootProvider.launcherPath must be an absolute path");
  }
  if (typeof rootProvider.acceptanceBindingSha256 !== "string" ||
    !SHA256.test(rootProvider.acceptanceBindingSha256)) {
    errors.push("rootProvider.acceptanceBindingSha256 must be a sha256 hash");
  }
}

function validatePolicyFields(policy, { validateHash }) {
  const errors = [];
  if (!isPlainObject(policy)) return ["dispatch policy must be an object"];

  const policyFields = policy.schemaVersion === 2 ? POLICY_V2_FIELDS : POLICY_V1_FIELDS;
  for (const key of Object.keys(policy)) {
    if (!policyFields.has(key)) errors.push(`dispatch policy has unsupported field: ${key}`);
  }
  for (const key of policyFields) {
    if (!Object.hasOwn(policy, key)) errors.push(`dispatch policy missing ${key}`);
  }
  if (![1, 2].includes(policy.schemaVersion)) {
    errors.push("schemaVersion must equal 1 or 2");
  }
  if (policy.managedBy !== MANAGED_BY) errors.push("managedBy is not gearbox-managed");
  if (!MODES.has(policy.mode)) errors.push("mode must be active or shadow");
  if (policy.allowTypedBridge !== false) {
    errors.push("allowTypedBridge must be false for the supported schema");
  }
  if (policy.mode === "active") {
    if (policy.activation === null) errors.push("active policy requires activation");
    else validateActivation(policy.activation, errors);
  } else if (policy.mode === "shadow" && policy.activation !== null) {
    errors.push("shadow policy must not contain activation");
  }
  if (policy.schemaVersion === 2) {
    validateRootProvider(policy.rootProvider, policy.mode, errors);
  }
  if (validateHash) {
    if (typeof policy.sha256 !== "string" || !SHA256.test(policy.sha256)) {
      errors.push("sha256 must be 64 lowercase hex characters");
    } else if (policy.sha256 !== integrityDigest(policy)) {
      errors.push("sha256 integrity mismatch");
    }
  }
  return errors;
}

export function validateDispatchPolicy(policy) {
  const errors = validatePolicyFields(policy, { validateHash: true });
  return { pass: errors.length === 0, errors };
}

export function createDispatchPolicy({
  mode,
  allowTypedBridge,
  activation,
  rootProvider = undefined,
}) {
  const policy = {
    schemaVersion: rootProvider === undefined ? 1 : 2,
    managedBy: MANAGED_BY,
    mode,
    allowTypedBridge,
    activation,
    ...(rootProvider === undefined ? {} : { rootProvider }),
    sha256: "",
  };
  const errors = validatePolicyFields(policy, { validateHash: false });
  if (errors.length > 0) throw new TypeError(`invalid dispatch policy: ${errors.join("; ")}`);
  policy.sha256 = integrityDigest(policy);
  return policy;
}

export function serializeDispatchPolicy(policy) {
  const { pass, errors } = validateDispatchPolicy(policy);
  if (!pass) throw new TypeError(`invalid dispatch policy: ${errors.join("; ")}`);
  return `${JSON.stringify(stable(policy))}\n`;
}

function off(error) {
  return { state: "off", policy: null, error };
}

export async function loadDispatchPolicy(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return off("missing dispatch policy");
    return off(`unable to read dispatch policy: ${error.message}`);
  }

  let policy;
  try {
    policy = JSON.parse(source);
  } catch (error) {
    return off(`unable to parse dispatch policy: ${error.message}`);
  }
  const { pass, errors } = validateDispatchPolicy(policy);
  if (!pass) return off(`dispatch policy integrity failed: ${errors.join("; ")}`);
  return { state: policy.mode, policy, error: null };
}

export function assertManagedPolicyTarget(source) {
  if (source === null || source === undefined) return null;
  let policy;
  try {
    policy = JSON.parse(source);
  } catch {
    throw new TypeError("unmanaged dispatch policy: invalid JSON");
  }
  const { pass, errors } = validateDispatchPolicy(policy);
  if (!pass) throw new TypeError(`unmanaged dispatch policy: ${errors.join("; ")}`);
  return policy;
}
