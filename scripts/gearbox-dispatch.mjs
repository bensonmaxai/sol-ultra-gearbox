#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, realpath, readFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ROLE_SPECS, redactSensitive, sha256 } from "../lib/gearbox.mjs";
import { planDispatch } from "../lib/dispatch-planner.mjs";
import { DISPATCH_POLICY_RELATIVE_PATH, loadDispatchPolicy } from "../lib/dispatch-policy.mjs";
import { runIsolatedRole } from "../lib/dispatch-runner.mjs";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const OWNED_PACKET_DIRECTORY = /^sol-ultra-gearbox-v2-dispatch-packet-[A-Za-z0-9]+$/;

function off() {
  return { status: "GEARBOX_DISPATCH_OFF", mode: "off" };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function ownedMetadata(metadata, type) {
  return (
    (type === "directory" ? metadata.isDirectory() : metadata.isFile()) &&
    !metadata.isSymbolicLink() &&
    (typeof process.getuid !== "function" || metadata.uid === process.getuid()) &&
    (metadata.mode & 0o077) === 0
  );
}

async function resolveOwnedPacket(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("owned dispatch packet path is required");
  }
  const tempRoot = await realpath(tmpdir());
  const requested = resolve(path);
  const requestedMetadata = await lstat(requested);
  if (requestedMetadata.isSymbolicLink()) {
    throw new TypeError("dispatch packet must not be a symlink");
  }
  const absolute = await realpath(requested);
  const fromTemp = relative(tempRoot, absolute);
  if (
    fromTemp === "" ||
    fromTemp === ".." ||
    fromTemp.startsWith(`..${sep}`) ||
    !fromTemp.includes(sep)
  ) {
    throw new TypeError("dispatch packet must be beneath an owned temporary directory");
  }
  const [directoryName] = fromTemp.split(sep);
  if (!OWNED_PACKET_DIRECTORY.test(directoryName)) {
    throw new TypeError("dispatch packet must be beneath an owned temporary directory");
  }
  const ownedDirectory = join(tempRoot, directoryName);
  if (dirname(ownedDirectory) !== tempRoot || (await realpath(ownedDirectory)) !== ownedDirectory) {
    throw new TypeError("dispatch packet directory must be a physical owned temporary directory");
  }
  if (!ownedMetadata(await lstat(ownedDirectory), "directory")) {
    throw new TypeError("dispatch packet directory must be private and non-symlinked");
  }

  let current = ownedDirectory;
  while (current !== dirname(absolute)) {
    const metadata = await lstat(current);
    if (!ownedMetadata(metadata, "directory")) {
      throw new TypeError("dispatch packet directory must be private and non-symlinked");
    }
    const next = relative(current, absolute).split(sep)[0];
    current = join(current, next);
  }
  const parent = await lstat(dirname(absolute));
  const packet = await lstat(absolute);
  if (!ownedMetadata(parent, "directory") || !ownedMetadata(packet, "file")) {
    throw new TypeError("dispatch packet must be a private regular file");
  }
  return { absolute, packet };
}

async function readOwnedPacket(path, { consume }) {
  const owned = await resolveOwnedPacket(path);
  const handle = await open(owned.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const metadata = await handle.stat();
    if (!sameFile(owned.packet, metadata) || !ownedMetadata(metadata, "file")) {
      throw new TypeError("dispatch packet changed while opening");
    }
    source = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
  let packet;
  try {
    packet = JSON.parse(source);
  } catch {
    throw new TypeError("dispatch packet must contain JSON");
  }
  if (consume) {
    const current = await lstat(owned.absolute);
    if (!sameFile(owned.packet, current) || !ownedMetadata(current, "file")) {
      throw new TypeError("dispatch packet changed before consume");
    }
    await unlink(owned.absolute);
  }
  return packet;
}

function parsePacketArguments(args) {
  if (args.includes("--packet") && args.filter((value) => value === "--packet").length !== 1) {
    throw new TypeError("dispatch command accepts exactly one packet path");
  }
  const index = args.indexOf("--packet");
  if (index < 0 || !args[index + 1] || args.some((value, position) => position !== index && position !== index + 1 && value !== "--consume")) {
    throw new TypeError("dispatch command requires --packet <owned-temp-json> [--consume]");
  }
  return { packetPath: args[index + 1], consume: args.includes("--consume") };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(redactSensitive(value))}\n`);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

async function dispatchPolicy() {
  return loadDispatchPolicy(join(CODEX_HOME, DISPATCH_POLICY_RELATIVE_PATH));
}

async function main() {
  const [, , command, ...args] = process.argv;
  const loaded = await dispatchPolicy();
  if (loaded.state === "off") {
    output(off());
    process.exitCode = 1;
    return;
  }
  if (command === "status" && args.length === 0) {
    output({ status: `GEARBOX_DISPATCH_${loaded.state.toUpperCase()}`, mode: loaded.state });
    return;
  }
  if (command !== "plan" && command !== "run-isolated") throw new TypeError("unknown dispatch command");

  const { packetPath, consume } = parsePacketArguments(args);
  const packet = await readOwnedPacket(packetPath, { consume });
  const decision = planDispatch({
    policy: loaded.policy,
    packet,
    capabilities: {
      agentTypeVisible: true,
      runtimeMetadataAvailable: true,
      bridgeRuntimeVerified: false,
      permissionBypassActive: false,
    },
    roleSpecs: ROLE_SPECS,
  });
  if (command === "plan") {
    output({ status: "GEARBOX_DISPATCH_PLAN", mode: loaded.state, decision });
    return;
  }
  if (decision.effectiveShape !== "isolated_role_root") {
    output({ status: "GEARBOX_DISPATCH_NOT_ISOLATED", mode: loaded.state, decision });
    process.exitCode = 1;
    return;
  }
  const roleSpec = ROLE_SPECS.find((role) => role.name === decision.role);
  if (!roleSpec) throw new TypeError("isolated role is not installed");
  const roleSource = await readFile(join(CODEX_HOME, "agents", roleSpec.installFile), "utf8");
  const task = JSON.stringify(stable(packet));
  if (sha256(task) !== decision.taskHash) throw new TypeError("dispatch task packet hash mismatch");
  let deliverable = null;
  const result = await runIsolatedRole({
    codexHome: CODEX_HOME,
    roleSpec,
    roleSource,
    cwd: process.cwd(),
    task,
    taskHash: decision.taskHash,
    onDeliverable: async (value) => {
      deliverable = value;
      return true;
    },
  });
  if (result.pass !== true) {
    output({ status: "GEARBOX_DISPATCH_REJECTED", mode: loaded.state, decision, result });
    process.exitCode = 1;
    return;
  }
  output({ status: "GEARBOX_DISPATCH_RESULT", mode: loaded.state, decision, result, deliverable });
}

main().catch(() => {
  output(off());
  process.exitCode = 1;
});
