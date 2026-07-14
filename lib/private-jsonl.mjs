import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const FORBIDDEN_FIELDS = new Set([
  "prompt",
  "message",
  "goal",
  "sessionid",
  "threadid",
  "executionid",
  "path",
  "cwd",
  "auth",
  "secret",
  "token",
  "stdout",
  "stderr",
]);
const PRIVATE_HOME = /\/(?:Users|home)\/(?!example(?:\/|$)|test(?:\/|$)|username(?:\/|$))[^\s"'`]*/;

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function scanPrivacy(value, label, errors, seen) {
  if (typeof value === "string") {
    if (PRIVATE_HOME.test(value)) errors.push(`${label} contains a private absolute home path`);
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      errors.push(`${label} contains a cyclic value`);
      return;
    }
    seen.add(value);
    value.forEach((item, index) => scanPrivacy(item, `${label}[${index}]`, errors, seen));
    seen.delete(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) {
    errors.push(`${label} contains a cyclic value`);
    return;
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      errors.push(`${label} contains forbidden field: ${key}`);
    }
    scanPrivacy(child, `${label}.${key}`, errors, seen);
  }
  seen.delete(value);
}

export function privacyErrors(value, label = "record") {
  const errors = [];
  scanPrivacy(value, label, errors, new WeakSet());
  return errors;
}

function ownedByCurrentUser(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function nearestExisting(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function assertOwnedChainHasNoSymlink(path, label) {
  let current = resolve(path);
  while (true) {
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new TypeError(`${label} must not contain a symlinked parent`);
    }
    if (!ownedByCurrentUser(metadata)) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ensurePrivateParent(path, defaultPath) {
  const parent = resolve(dirname(path));
  if (!existsSync(parent)) {
    assertOwnedChainHasNoSymlink(nearestExisting(parent), "private JSONL parent");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  const metadata = lstatSync(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError("private JSONL parent must be a directory");
  }
  assertOwnedChainHasNoSymlink(parent, "private JSONL parent");
  if (!ownedByCurrentUser(metadata)) {
    throw new TypeError("private JSONL parent must be an owned 0700 directory");
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    if (resolve(path) !== resolve(defaultPath)) {
      throw new TypeError("private JSONL parent must be an owned 0700 directory");
    }
    chmodSync(parent, 0o700);
  }
  const finalMetadata = lstatSync(parent);
  if (!ownedByCurrentUser(finalMetadata) || (finalMetadata.mode & 0o777) !== 0o700) {
    throw new TypeError("private JSONL parent must be an owned 0700 directory");
  }
}

function assertPrivateFile(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError("private JSONL must be a regular file");
  }
  if (!ownedByCurrentUser(metadata) || (metadata.mode & 0o777) !== 0o600) {
    throw new TypeError("private JSONL must be an owned 0600 file");
  }
  return metadata;
}

function openVerified(path, flags, before = null) {
  const descriptor = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile() || !ownedByCurrentUser(metadata)) {
    closeSync(descriptor);
    throw new TypeError("private JSONL must be a regular file owned by the current user");
  }
  if (before && !sameFile(before, metadata)) {
    closeSync(descriptor);
    throw new TypeError("private JSONL changed while opening");
  }
  return { descriptor, metadata };
}

function assertComplete(path, metadata = assertPrivateFile(path)) {
  if (metadata.size === 0) return;
  const { descriptor } = openVerified(path, constants.O_RDONLY, metadata);
  try {
    const lastByte = Buffer.alloc(1);
    if (readSync(descriptor, lastByte, 0, 1, metadata.size - 1) !== 1 || lastByte[0] !== 0x0a) {
      throw new TypeError("private JSONL has an incomplete record");
    }
  } finally {
    closeSync(descriptor);
  }
}

function assertValidator(validate) {
  if (typeof validate !== "function") throw new TypeError("private JSONL validator is required");
}

function isJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export function isLosslessJsonObject(value) {
  return isPlainObject(value) && isJsonValue(value);
}

function assertValid(value, validate) {
  if (!isLosslessJsonObject(value)) {
    throw new TypeError("invalid private JSONL record: value must be a lossless JSON object");
  }
  const result = validate(value);
  if (!result || result.pass !== true || !Array.isArray(result.errors)) {
    const errors = Array.isArray(result?.errors) ? result.errors.join("; ") : "validator rejected value";
    throw new TypeError(`invalid private JSONL record: ${errors}`);
  }
}

export function appendPrivateJsonl(path, value, { defaultPath, validate }) {
  assertValidator(validate);
  if (typeof path !== "string" || path.length === 0 || typeof defaultPath !== "string" || defaultPath.length === 0) {
    throw new TypeError("private JSONL path and defaultPath are required");
  }
  assertValid(value, validate);
  ensurePrivateParent(path, defaultPath);
  const existed = existsSync(path);
  const before = existed ? assertPrivateFile(path) : null;
  if (before) assertComplete(path, before);

  const serialized = JSON.stringify(stableValue(value));
  if (typeof serialized !== "string") throw new TypeError("private JSONL value must be serializable");
  const line = `${serialized}\n`;
  const byteLength = Buffer.byteLength(line);
  const { descriptor, metadata } = openVerified(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    before,
  );
  try {
    if (!existed) fchmodSync(descriptor, 0o600);
    if ((metadata.mode & 0o777) !== 0o600 && existed) {
      throw new TypeError("private JSONL must be an owned 0600 file");
    }
    if (writeSync(descriptor, line, null, "utf8") !== byteLength) {
      throw new TypeError("private JSONL append was incomplete");
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function readPrivateJsonl(path, { defaultPath, validate }) {
  assertValidator(validate);
  if (typeof path !== "string" || path.length === 0 || typeof defaultPath !== "string" || defaultPath.length === 0) {
    throw new TypeError("private JSONL path and defaultPath are required");
  }
  const parent = resolve(dirname(path));
  if (!existsSync(parent)) {
    assertOwnedChainHasNoSymlink(nearestExisting(parent), "private JSONL parent");
    return [];
  }
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || !ownedByCurrentUser(parentMetadata) || (parentMetadata.mode & 0o777) !== 0o700) {
    throw new TypeError("private JSONL parent must be an owned 0700 directory");
  }
  assertOwnedChainHasNoSymlink(parent, "private JSONL parent");
  if (!existsSync(path)) return [];
  const before = assertPrivateFile(path);
  assertComplete(path, before);
  const { descriptor } = openVerified(path, constants.O_RDONLY, before);
  let source;
  try {
    source = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  const records = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (line.length === 0) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new TypeError(`private JSONL line ${index + 1} is malformed`);
    }
    try {
      assertValid(value, validate);
    } catch (error) {
      throw new TypeError(`private JSONL line ${index + 1} is invalid: ${error.message}`);
    }
    records.push(value);
  }
  return records;
}
