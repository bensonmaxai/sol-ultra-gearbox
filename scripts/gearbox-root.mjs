#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  APP_SERVER_ROOT_SMOKE_MARKER,
  createAppServerRootSmokePacket,
  probeAppServerHandshake,
  runAppServerRoot,
  validateRootProviderScope,
} from "../lib/app-server-root-provider.mjs";
import { ROLE_SPECS } from "../lib/gearbox.mjs";
import {
  APP_SERVER_ROOT_PROVIDER_CAPABILITIES,
  planRootLaunch,
} from "../lib/dispatch-planner.mjs";
import {
  DISPATCH_POLICY_RELATIVE_PATH,
  loadDispatchPolicy,
} from "../lib/dispatch-policy.mjs";
import { readOwnedPacket } from "../lib/owned-packet.mjs";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

function output(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function parseArgs(command, args) {
  let packetPath = null;
  let consume = false;
  let cwd = process.cwd();
  let timeoutMs = 30 * 60_000;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--consume") {
      if (consume) throw new TypeError("--consume may be specified once");
      consume = true;
      continue;
    }
    if (value === "--packet") {
      if (packetPath !== null || !args[index + 1]) {
        throw new TypeError("--packet requires one path");
      }
      packetPath = args[index + 1];
      index += 1;
      continue;
    }
    if (value === "--cwd") {
      if (!args[index + 1] || !isAbsolute(args[index + 1])) {
        throw new TypeError("--cwd requires an absolute path");
      }
      cwd = resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--timeout-ms") {
      timeoutMs = Number(args[index + 1]);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
        throw new TypeError("--timeout-ms must be an integer from 1000 to 3600000");
      }
      index += 1;
      continue;
    }
    throw new TypeError(`unknown gearbox-root argument: ${value}`);
  }
  if (["plan", "launch"].includes(command) && packetPath === null) {
    throw new TypeError(`${command} requires --packet <owned-temp-json>`);
  }
  if (command === "handshake" && (packetPath !== null || consume || args.length > 0)) {
    throw new TypeError("handshake accepts no packet arguments");
  }
  if (command === "smoke" && (packetPath !== null || consume)) {
    throw new TypeError("smoke accepts only --cwd and --timeout-ms");
  }
  return { packetPath, consume, cwd, timeoutMs };
}

async function capture(command, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", () => rejectCapture(new Error("managed dispatch status failed to start")));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveCapture({ code, signal, stdout, stderr });
    });
  });
}

async function activePolicy() {
  const loaded = await loadDispatchPolicy(join(CODEX_HOME, DISPATCH_POLICY_RELATIVE_PATH));
  if (loaded.state !== "active" || loaded.policy?.schemaVersion !== 2 ||
    loaded.policy?.rootProvider?.kind !== "app_server_root" ||
    loaded.policy?.rootProvider?.enabled !== true ||
    loaded.policy.rootProvider.launcherPath !== join(CODEX_HOME, "bin", "gearbox-root")) {
    throw new Error("APP_SERVER_ROOT_POLICY_DISABLED");
  }
  return loaded.policy;
}

async function verifyInstalledIntegrity(policy) {
  const launcher = join(CODEX_HOME, "bin", "gearbox-dispatch");
  const metadata = await lstat(launcher);
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(launcher) !== launcher) {
    throw new Error("APP_SERVER_ROOT_DISPATCH_INTEGRITY_FAILED");
  }
  const status = await capture(launcher, ["status"]);
  if (status.code !== 0 || status.signal !== null || status.stderr !== "") {
    throw new Error("APP_SERVER_ROOT_DISPATCH_INTEGRITY_FAILED");
  }
  let value;
  try {
    value = JSON.parse(status.stdout);
  } catch {
    throw new Error("APP_SERVER_ROOT_DISPATCH_INTEGRITY_FAILED");
  }
  if (value.status !== "GEARBOX_DISPATCH_ACTIVE" || value.integrity !== "pass" ||
    value.policySha256 !== policy.sha256) {
    throw new Error("APP_SERVER_ROOT_DISPATCH_INTEGRITY_FAILED");
  }
  return value;
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!["plan", "launch", "handshake", "smoke"].includes(command)) {
    throw new TypeError("usage: gearbox-root plan|launch|handshake|smoke");
  }
  const parsed = parseArgs(command, args);
  const policy = await activePolicy();
  await verifyInstalledIntegrity(policy);

  if (command === "handshake") {
    const result = await probeAppServerHandshake({
      serverCommand: [CODEX_BIN, "app-server", "--stdio"],
      cwd: process.cwd(),
      codexHome: CODEX_HOME,
    });
    output({
      status: result.pass ? "GEARBOX_APP_SERVER_HANDSHAKE_PASS" : "GEARBOX_APP_SERVER_HANDSHAKE_FAILED",
      ...result,
    });
    if (!result.pass) process.exitCode = 1;
    return;
  }

  const packet = command === "smoke"
    ? createAppServerRootSmokePacket()
    : await readOwnedPacket(parsed.packetPath, { consume: parsed.consume });
  await validateRootProviderScope({ cwd: parsed.cwd, packet });
  if (command === "plan") {
    const discoveryCapabilities = Object.fromEntries(
      APP_SERVER_ROOT_PROVIDER_CAPABILITIES.map((key) => [
        key,
        key === "ownerAuthorized",
      ]),
    );
    let decision = planRootLaunch({
      policy,
      packet,
      capabilities: discoveryCapabilities,
      roleSpecs: ROLE_SPECS,
    });
    if (decision.workflowPolicy.pass &&
      decision.provider.checks.policyEnabled &&
      decision.provider.checks.paidAcceptanceCurrent) {
      const probe = await probeAppServerHandshake({
        serverCommand: [CODEX_BIN, "app-server", "--stdio"],
        cwd: parsed.cwd,
        codexHome: CODEX_HOME,
      });
      decision = planRootLaunch({
        policy,
        packet,
        capabilities: probe.capabilities,
        roleSpecs: ROLE_SPECS,
      });
    }
    output({ status: "GEARBOX_ROOT_PLAN", decision });
    return;
  }

  const result = await runAppServerRoot({
    policy,
    packet,
    cwd: parsed.cwd,
    codexHome: CODEX_HOME,
    serverCommand: [CODEX_BIN, "app-server", "--stdio"],
    turnTimeoutMs: parsed.timeoutMs,
  });
  if (result.status === "pass") {
    const text = result.finalTexts.at(-1) ?? "GEARBOX_ROOT_COMPLETED";
    if (command === "smoke" && text.trim() !== APP_SERVER_ROOT_SMOKE_MARKER) {
      output({
        status: "GEARBOX_ROOT_FAILED",
        reasonCode: "APP_SERVER_ROOT_SMOKE_MARKER_MISMATCH",
        receiptSha256: result.receipt.sha256,
      });
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${text.trimEnd()}\n`);
    output({
      status: "GEARBOX_ROOT_RUNTIME_VERIFIED",
      route: result.decision.routing.root,
      receiptSha256: result.receipt.sha256,
    }, process.stderr);
    return;
  }
  output({
    status: result.status === "fallback" ? "GEARBOX_ROOT_FALLBACK" : "GEARBOX_ROOT_FAILED",
    reasonCode: result.receipt?.value?.reasonCode ?? result.decision.provider.reasonCode,
    decision: result.status === "fallback" ? result.decision : undefined,
    receiptSha256: result.receipt?.sha256 ?? null,
  });
  process.exitCode = result.status === "fallback" ? 2 : 1;
}

main().catch((error) => {
  output({
    status: "GEARBOX_ROOT_FAILED",
    reasonCode: typeof error?.message === "string" && /^APP_SERVER_ROOT_[A-Z_]+$/.test(error.message)
      ? error.message
      : "APP_SERVER_ROOT_COMMAND_FAILED",
  });
  process.exitCode = 1;
});
