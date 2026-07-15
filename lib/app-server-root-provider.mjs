import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ROLE_SPECS,
  atomicWrite,
  sha256,
  summarizeRollout,
} from "./gearbox.mjs";
import {
  APP_SERVER_ROOT_PROVIDER_CAPABILITIES,
  planRootLaunch,
  renderTaskMessage,
} from "./dispatch-planner.mjs";

const SAFE_SCOPE = /^[^\0]+$/;
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const SUPPORTED_APP_SERVER_VERSIONS = new Set(["0.144.2"]);

export const APP_SERVER_ROOT_SMOKE_MARKER = "GEARBOX_APP_SERVER_ROOT_OK";

export function createAppServerRootSmokePacket() {
  return {
    schemaVersion: 1,
    workflowAdapter: "direct",
    responsibility: "review",
    goal: `Return exactly ${APP_SERVER_ROOT_SMOKE_MARKER} and perform no tool calls.`,
    readScope: ["README.md"],
    writeScope: [],
    knownFacts: ["This is a bounded foreground provider verification turn."],
    constraints: ["Do not call tools", "Do not read or modify files"],
    deliverable: APP_SERVER_ROOT_SMOKE_MARKER,
    successCriteria: [`The complete final response is exactly ${APP_SERVER_ROOT_SMOKE_MARKER}`],
    checks: ["Persist and verify the selected model, effort, usage, scope, and close lifecycle"],
    prohibitedActions: ["Do not request more authority", "Do not disclose workspace contents"],
    parentPermission: "workspace-write",
    requiredPermission: "read-only",
    requiresNativeLineage: false,
    requestedRole: null,
    ownerOptIn: false,
    legacyAdapter: false,
    batch: {
      requestedChildren: 1,
      writerCount: 0,
      scopesDisjoint: true,
      independentWorkstreams: 0,
    },
    riskSignals: {
      ambiguous: false,
      hiddenCoupling: false,
      highRisk: false,
      weakVerification: false,
    },
    costSignals: {
      estimatedRootToolCalls: 1,
      oneLocation: true,
      packagingDominates: false,
      directlyConsumable: true,
      repetitiveReads: 0,
      moduleCount: 1,
      fileCount: 1,
      bytes: 0,
      lines: 0,
      itemCount: 1,
      includesRegressionTest: false,
      boundedFileCount: 1,
    },
  };
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

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function appServerRootScopeBinding(packet) {
  return {
    readScopeSha256: hashValue(packet.readScope),
    writeScopeSha256: hashValue(packet.writeScope),
  };
}

export function deriveAppServerRootCapabilities(initializeResult, {
  codexHome,
  ownerAuthorized = true,
} = {}) {
  const userAgentMatch = /^Codex Desktop\/([0-9]+\.[0-9]+\.[0-9]+)\b/.exec(
    initializeResult?.userAgent ?? "",
  );
  const serverVersion = userAgentMatch?.[1] ?? null;
  const checks = {
    responseShape: exactFields(initializeResult, [
      "codexHome", "platformFamily", "platformOs", "userAgent",
    ]),
    codexHome:
      typeof codexHome === "string" && isAbsolute(codexHome) &&
      typeof initializeResult?.codexHome === "string" &&
      isAbsolute(initializeResult.codexHome) &&
      resolve(initializeResult.codexHome) === resolve(codexHome),
    platform:
      initializeResult?.platformFamily === "unix" &&
      initializeResult?.platformOs === "macos",
    version: SUPPORTED_APP_SERVER_VERSIONS.has(serverVersion),
  };
  const compatible = Object.values(checks).every(Boolean);
  const capabilities = Object.fromEntries(
    APP_SERVER_ROOT_PROVIDER_CAPABILITIES.map((key) => [
      key,
      key === "ownerAuthorized" ? ownerAuthorized === true : compatible,
    ]),
  );
  return {
    pass: compatible && ownerAuthorized === true,
    reasonCode: compatible
      ? ownerAuthorized === true
        ? "APP_SERVER_ROOT_CAPABILITIES_VERIFIED"
        : "APP_SERVER_ROOT_OWNER_AUTHORITY_REQUIRED"
      : "APP_SERVER_ROOT_VERSION_UNSUPPORTED",
    serverVersion,
    checks,
    capabilities,
  };
}

function pathWithin(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function safeRelativeScope(scope) {
  return typeof scope === "string" && SAFE_SCOPE.test(scope) &&
    !isAbsolute(scope) && scope.length > 0 &&
    !scope.split(/[\\/]/).some((part) => part.length === 0 || part === "." || part === "..");
}

async function nearestExisting(path) {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT" || current === dirname(current)) throw error;
      current = dirname(current);
    }
  }
}

async function validateScopePath(root, scope, { requireExisting }) {
  if (!safeRelativeScope(scope)) throw new TypeError("root provider scope must be a safe relative path");
  const target = resolve(root, scope);
  if (!pathWithin(root, target) || target === root) {
    throw new TypeError("root provider scope escapes the workspace");
  }
  const existing = await nearestExisting(target);
  const physicalExisting = await realpath(existing);
  if (!pathWithin(root, physicalExisting)) {
    throw new TypeError("root provider scope traverses a symlink");
  }
  if (requireExisting) {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || await realpath(target) !== target) {
      throw new TypeError("root provider read scope must be physical");
    }
  }
  return target;
}

export async function validateRootProviderScope({ cwd, packet }) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new TypeError("root provider cwd must be absolute");
  }
  const requestedRoot = resolve(cwd);
  const requestedMetadata = await lstat(requestedRoot);
  const physicalRoot = await realpath(requestedRoot);
  const metadata = await lstat(physicalRoot);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink() ||
    !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError("root provider cwd must be a physical directory");
  }
  const readScope = [];
  for (const scope of packet.readScope) {
    readScope.push(await validateScopePath(physicalRoot, scope, { requireExisting: true }));
  }
  const writeScope = [];
  for (const scope of packet.writeScope) {
    writeScope.push(await validateScopePath(physicalRoot, scope, { requireExisting: false }));
  }
  return { physicalRoot, readScope, writeScope };
}

async function snapshotWorkspace(root) {
  const entries = new Map();
  async function visit(current) {
    const names = await readdir(current, { withFileTypes: true });
    for (const entry of names.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const scope = relative(root, path);
      const metadata = await lstat(path);
      const common = {
        mode: metadata.mode & 0o777,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
      };
      if (metadata.isSymbolicLink()) {
        entries.set(scope, {
          kind: "symlink",
          ...common,
          sha256: sha256(await readlink(path)),
        });
      } else if (metadata.isDirectory()) {
        entries.set(scope, { kind: "directory", ...common, sha256: null });
        await visit(path);
      } else if (metadata.isFile()) {
        entries.set(scope, {
          kind: "file",
          ...common,
          sha256: sha256(await readFile(path)),
        });
      } else {
        entries.set(scope, { kind: "other", ...common, sha256: null });
      }
    }
  }
  await visit(root);
  return entries;
}

function workspaceChanges(before, after) {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.filter((path) =>
    JSON.stringify(before.get(path) ?? null) !== JSON.stringify(after.get(path) ?? null),
  );
}

function scopeAllows(path, scopes) {
  return scopes.some((scope) => path === scope || path.startsWith(`${scope}${sep}`));
}

function scopeChangeAllowed(path, before, after, scopes) {
  if (scopeAllows(path, scopes)) return true;
  if (!scopes.some((scope) => scope.startsWith(`${path}${sep}`))) return false;
  const previous = before.get(path) ?? null;
  const current = after.get(path) ?? null;
  if (current?.kind !== "directory") return false;
  if (previous === null) return true;
  return previous.kind === "directory" && previous.mode === current.mode;
}

function privacySafeChanges(changes) {
  return changes.map((path) => ({ pathSha256: sha256(path) }));
}

class JsonRpcStdioClient {
  constructor(command, args, options, { requestTimeoutMs }) {
    this.child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.serverRequestObserved = false;
    this.stderr = "";
    this.exited = false;
    this.exit = new Promise((resolveExit) => {
      this.child.once("close", (code, signal) => {
        this.exited = true;
        for (const pending of this.pending.values()) {
          pending.reject(new Error("App Server exited before responding"));
        }
        this.pending.clear();
        for (const waiter of this.waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("App Server exited before notification"));
        }
        this.waiters.length = 0;
        resolveExit({ code, signal });
      });
    });
    this.child.once("error", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("App Server process failed to start"));
      }
      this.pending.clear();
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-65_536);
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.#onLine(line));
  }

  #write(value) {
    if (this.exited || !this.child.stdin.writable) throw new Error("App Server stdin is closed");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #onLine(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.hasOwn(value, "id") && !Object.hasOwn(value, "method")) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error("App Server request failed"));
      else pending.resolve(value.result);
      return;
    }
    if (Object.hasOwn(value, "id") && typeof value.method === "string") {
      this.serverRequestObserved = true;
      this.#write({
        id: value.id,
        error: { code: -32603, message: "Gearbox root provider refuses interactive server requests" },
      });
      return;
    }
    if (typeof value.method === "string") {
      const index = this.waiters.findIndex((waiter) =>
        waiter.method === value.method && waiter.predicate(value.params),
      );
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(value.params);
      } else {
        this.notifications.push(value);
      }
    }
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error("App Server request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  notify(method, params = undefined) {
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  waitFor(method, predicate = () => true, timeoutMs = this.requestTimeoutMs) {
    const index = this.notifications.findIndex((value) =>
      value.method === method && predicate(value.params),
    );
    if (index >= 0) return Promise.resolve(this.notifications.splice(index, 1)[0].params);
    return new Promise((resolveNotification, rejectNotification) => {
      const waiter = { method, predicate, resolve: resolveNotification, reject: rejectNotification, timer: null };
      waiter.timer = setTimeout(() => {
        const position = this.waiters.indexOf(waiter);
        if (position >= 0) this.waiters.splice(position, 1);
        rejectNotification(new Error("App Server notification timed out"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async close(timeoutMs = 5_000) {
    if (!this.exited) this.child.stdin.end();
    const waitForExit = async (waitMs) => {
      if (this.exited) return this.exit;
      let timeoutId;
      const timeout = new Promise((resolveTimeout) => {
        timeoutId = setTimeout(() => resolveTimeout(null), waitMs);
      });
      const result = await Promise.race([this.exit, timeout]);
      clearTimeout(timeoutId);
      return result;
    };
    let result = await waitForExit(timeoutMs);
    if (result === null && !this.exited) {
      this.child.kill("SIGTERM");
      result = await waitForExit(Math.min(timeoutMs, 1_000));
    }
    if (result === null && !this.exited) {
      this.child.kill("SIGKILL");
      result = await waitForExit(Math.min(timeoutMs, 1_000));
    }
    this.lines.close();
    return result ?? { code: null, signal: "UNCONFIRMED" };
  }
}

export async function probeAppServerHandshake({
  serverCommand,
  cwd,
  requestTimeoutMs = 10_000,
  closeTimeoutMs = 5_000,
  codexHome,
  environment = process.env,
}) {
  if (!Array.isArray(serverCommand) || serverCommand.length === 0) {
    throw new TypeError("App Server command must be a non-empty argv array");
  }
  const [command, ...args] = serverCommand;
  const client = new JsonRpcStdioClient(command, args, {
    cwd,
    env: environment,
  }, { requestTimeoutMs });
  try {
    const initialized = await client.request("initialize", {
      clientInfo: { name: "sol-ultra-gearbox-root", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    const discovery = deriveAppServerRootCapabilities(initialized, { codexHome });
    client.notify("initialized");
    await new Promise((resolveDrain) => setTimeout(resolveDrain, 250));
    const exit = await client.close(closeTimeoutMs);
    return {
      pass:
        discovery.pass &&
        !client.serverRequestObserved &&
        exit.code === 0 && exit.signal === null,
      transport: "stdio",
      initialized: discovery.checks.responseShape,
      reasonCode: discovery.reasonCode,
      serverVersion: discovery.serverVersion,
      capabilities: discovery.capabilities,
      serverExitCode: exit.code,
      serverExitSignal: exit.signal,
      stderrBytes: Buffer.byteLength(client.stderr),
      stderrSha256: sha256(client.stderr),
    };
  } catch {
    const exit = await client.close(closeTimeoutMs);
    return {
      pass: false,
      transport: "stdio",
      initialized: false,
      reasonCode: "APP_SERVER_ROOT_HANDSHAKE_FAILED",
      serverVersion: null,
      capabilities: Object.fromEntries(
        APP_SERVER_ROOT_PROVIDER_CAPABILITIES.map((key) => [
          key,
          key === "ownerAuthorized",
        ]),
      ),
      serverExitCode: exit?.code ?? null,
      serverExitSignal: exit?.signal ?? null,
      stderrBytes: Buffer.byteLength(client.stderr),
      stderrSha256: sha256(client.stderr),
    };
  }
}

function threadId(value) {
  return value?.thread?.id ?? value?.threadId ?? null;
}

function turnId(value) {
  return value?.turn?.id ?? value?.turnId ?? null;
}

function findTurn(value, expectedId) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findTurn(item, expectedId);
      if (match) return match;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (value.id === expectedId && typeof value.status === "string") return value;
  for (const child of Object.values(value)) {
    const match = findTurn(child, expectedId);
    if (match) return match;
  }
  return null;
}

export function rolloutContainsExactMessage(source, role, expectedText) {
  if (typeof source !== "string" || typeof role !== "string" ||
    typeof expectedText !== "string") return false;
  const texts = [];
  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.role === role && Array.isArray(value.content)) {
      for (const item of value.content) {
        if (typeof item?.text === "string") texts.push(item.text);
      }
    }
    Object.values(value).forEach(visit);
  }
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      return false;
    }
  }
  return texts.includes(expectedText);
}

async function verifiedRollout({ path, codexHome, thread, route, cwd, taskMessage }) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("App Server thread did not expose persisted rollout evidence");
  }
  const requestedHome = resolve(codexHome);
  const homeMetadata = await lstat(requestedHome);
  const physicalHome = await realpath(requestedHome);
  const requestedPath = resolve(path);
  const requestedMetadata = await lstat(requestedPath);
  const physicalPath = await realpath(requestedPath);
  const metadata = await lstat(physicalPath);
  if (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink() ||
    physicalHome !== requestedHome || requestedMetadata.isSymbolicLink() ||
    requestedPath !== physicalPath || !metadata.isFile() || metadata.isSymbolicLink() ||
    !pathWithin(physicalHome, physicalPath)) {
    throw new Error("App Server rollout evidence escaped CODEX_HOME");
  }
  const source = await readFile(physicalPath, "utf8");
  const summary = await summarizeRollout(physicalPath);
  const identityMatches = [thread.id, thread.sessionId].includes(summary.sessionId);
  const checks = {
    persisted: Boolean(summary.sessionMeta && summary.turnContext),
    identityMatches,
    cwdMatches: summary.sessionMeta?.cwd === cwd,
    modelMatches: summary.turnContext?.model === route.model,
    effortMatches: summary.turnContext?.effort === route.effort,
    taskMessageMatches: rolloutContainsExactMessage(source, "user", taskMessage),
    tokenUsagePersisted: Number.isFinite(summary.tokenUsage?.total_tokens),
  };
  if (!Object.values(checks).every(Boolean)) {
    throw new Error("App Server persisted runtime evidence did not match the requested route");
  }
  return { summary, checks, rolloutSha256: sha256(source) };
}

function receiptPath(codexHome, taskHash, startedAtMs) {
  const stamp = new Date(startedAtMs).toISOString().replaceAll(/[:.]/g, "-");
  return join(codexHome, "gearbox", "root-receipts", `${stamp}-${taskHash.slice(0, 16)}.json`);
}

async function persistReceipt(path, receipt) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() ||
    (parentMetadata.mode & 0o077) !== 0 || await realpath(parent) !== parent) {
    throw new Error("App Server receipt directory is not private and physical");
  }
  await atomicWrite(path, `${JSON.stringify(stable(receipt), null, 2)}\n`, 0o600);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || await realpath(path) !== path) {
    throw new Error("App Server receipt is not private and physical");
  }
  return { path, sha256: sha256(await readFile(path)) };
}

function failureCode(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("scope")) return "APP_SERVER_ROOT_SCOPE_FAILED";
  if (message.includes("runtime evidence") || message.includes("rollout")) {
    return "APP_SERVER_ROOT_RUNTIME_EVIDENCE_FAILED";
  }
  if (message.includes("timed out")) return "APP_SERVER_ROOT_TIMEOUT";
  return "APP_SERVER_ROOT_LIFECYCLE_FAILED";
}

function exactFields(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
}

export function validateAppServerRootReceipt(receipt, { policySha256 = null } = {}) {
  const checks = {
    topLevel: exactFields(receipt, [
      "schemaVersion", "kind", "status", "reasonCode", "startedAt", "completedAt",
      "taskHash", "policySha256", "route", "provider", "scope", "runtime",
      "lifecycle", "diagnostics",
    ]),
    identity:
      receipt?.schemaVersion === 1 &&
      receipt?.kind === "gearbox-app-server-root-receipt" &&
      receipt?.status === "pass" &&
      receipt?.reasonCode === "APP_SERVER_ROOT_RUNTIME_VERIFIED" &&
      /^[a-f0-9]{64}$/.test(receipt?.taskHash ?? "") &&
      /^[a-f0-9]{64}$/.test(receipt?.policySha256 ?? "") &&
      (policySha256 === null || receipt?.policySha256 === policySha256),
    timestamps:
      Number.isFinite(Date.parse(receipt?.startedAt ?? "")) &&
      Number.isFinite(Date.parse(receipt?.completedAt ?? "")) &&
      Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt),
    route:
      exactFields(receipt?.route, ["model", "effort", "reasonCode"]) &&
      receipt?.route?.model === "gpt-5.6-sol" &&
      ["low", "medium", "max", "ultra"].includes(receipt?.route?.effort),
    provider:
      exactFields(receipt?.provider, [
        "kind", "transport", "serverVersion", "threadIdSha256", "turnIdSha256",
        "modelProvider",
      ]) &&
      receipt?.provider?.kind === "app_server_root" &&
      receipt?.provider?.transport === "stdio" &&
      SUPPORTED_APP_SERVER_VERSIONS.has(receipt?.provider?.serverVersion) &&
      /^[a-f0-9]{64}$/.test(receipt?.provider?.threadIdSha256 ?? "") &&
      /^[a-f0-9]{64}$/.test(receipt?.provider?.turnIdSha256 ?? "") &&
      typeof receipt?.provider?.modelProvider === "string" &&
      receipt.provider.modelProvider.length > 0,
    scope:
      exactFields(receipt?.scope, [
        "cwdSha256", "readScopeSha256", "writeScopeSha256", "changedPathCount",
        "changes", "verified",
      ]) &&
      [receipt?.scope?.cwdSha256, receipt?.scope?.readScopeSha256,
        receipt?.scope?.writeScopeSha256].every((value) => /^[a-f0-9]{64}$/.test(value ?? "")) &&
      Number.isInteger(receipt?.scope?.changedPathCount) &&
      receipt.scope.changedPathCount >= 0 &&
      Array.isArray(receipt?.scope?.changes) &&
      receipt.scope.changes.length === receipt.scope.changedPathCount &&
      receipt.scope.changes.every((entry) =>
        exactFields(entry, ["pathSha256"]) && /^[a-f0-9]{64}$/.test(entry.pathSha256),
      ) && receipt?.scope?.verified === true,
    runtime:
      exactFields(receipt?.runtime, ["rolloutSha256", "resultSha256", "checks", "tokenUsage"]) &&
      /^[a-f0-9]{64}$/.test(receipt?.runtime?.rolloutSha256 ?? "") &&
      /^[a-f0-9]{64}$/.test(receipt?.runtime?.resultSha256 ?? "") &&
      exactFields(receipt?.runtime?.checks, [
        "persisted", "identityMatches", "cwdMatches", "modelMatches", "effortMatches",
        "taskMessageMatches", "tokenUsagePersisted",
      ]) &&
      Object.values(receipt?.runtime?.checks ?? {}).every((value) => value === true) &&
      Number.isFinite(receipt?.runtime?.tokenUsage?.total_tokens),
    lifecycle:
      exactFields(receipt?.lifecycle, [
        "initialized", "threadStarted", "turnStarted", "turnCompleted", "readback",
        "archived", "unsubscribed", "serverRequestObserved", "serverExitCode",
        "serverExitSignal",
      ]) &&
      ["initialized", "threadStarted", "turnStarted", "turnCompleted", "readback",
        "archived", "unsubscribed"].every((key) => receipt?.lifecycle?.[key] === true) &&
      receipt?.lifecycle?.serverRequestObserved === false &&
      receipt?.lifecycle?.serverExitCode === 0 && receipt?.lifecycle?.serverExitSignal === null,
    diagnostics:
      exactFields(receipt?.diagnostics, ["stderrBytes", "stderrSha256"]) &&
      Number.isInteger(receipt?.diagnostics?.stderrBytes) && receipt.diagnostics.stderrBytes >= 0 &&
      /^[a-f0-9]{64}$/.test(receipt?.diagnostics?.stderrSha256 ?? ""),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export async function runAppServerRoot({
  policy,
  packet,
  cwd,
  codexHome,
  serverCommand,
  nowMs = Date.now(),
  requestTimeoutMs = 30_000,
  turnTimeoutMs = 30 * 60_000,
  closeTimeoutMs = 5_000,
  environment = process.env,
}) {
  if (!Array.isArray(serverCommand) || serverCommand.length === 0 ||
    serverCommand.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new TypeError("App Server command must be a non-empty argv array");
  }
  const scope = await validateRootProviderScope({ cwd, packet });
  const discoveryCapabilities = Object.fromEntries(
    APP_SERVER_ROOT_PROVIDER_CAPABILITIES.map((key) => [key, key === "ownerAuthorized"]),
  );
  let decision = planRootLaunch({
    policy,
    packet,
    capabilities: discoveryCapabilities,
    roleSpecs: ROLE_SPECS,
    nowMs,
  });
  const hostDiscoveryAllowed =
    decision.workflowPolicy.pass === true &&
    decision.provider.checks.policyEnabled === true &&
    decision.provider.checks.paidAcceptanceCurrent === true;
  if (!hostDiscoveryAllowed) {
    return { status: "fallback", decision, receipt: null, finalTexts: [] };
  }

  const startedAt = new Date(nowMs).toISOString();
  const targetReceiptPath = receiptPath(codexHome, decision.taskHash, nowMs);
  const [command, ...args] = serverCommand;
  const client = new JsonRpcStdioClient(command, args, {
    cwd: scope.physicalRoot,
    env: environment,
  }, { requestTimeoutMs });
  let currentThreadId = null;
  let currentTurnId = null;
  let turnTerminal = false;
  let archived = false;
  let unsubscribed = false;
  let readback = null;
  let runtime = null;
  let discovery = null;
  let before = null;
  let after = null;
  let changes = [];
  let exit = null;
  try {
    const initialized = await client.request("initialize", {
      clientInfo: { name: "sol-ultra-gearbox-root", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    discovery = deriveAppServerRootCapabilities(initialized, { codexHome });
    client.notify("initialized");
    decision = planRootLaunch({
      policy,
      packet,
      capabilities: discovery.capabilities,
      roleSpecs: ROLE_SPECS,
      nowMs,
    });
    if (decision.selectedShape !== "app_server_root") {
      exit = await client.close(closeTimeoutMs);
      if (exit.code !== 0 || exit.signal !== null) {
        throw new Error("App Server capability probe did not close cleanly");
      }
      return { status: "fallback", decision, receipt: null, finalTexts: [] };
    }
    before = await snapshotWorkspace(scope.physicalRoot);

    const writeEnabled = packet.writeScope.length > 0;
    const threadStart = await client.request("thread/start", {
      cwd: scope.physicalRoot,
      model: decision.routing.root.model,
      sandbox: writeEnabled ? "workspace-write" : "read-only",
      runtimeWorkspaceRoots: [scope.physicalRoot],
      ephemeral: false,
      historyMode: "paginated",
    });
    currentThreadId = threadId(threadStart);
    const thread = threadStart?.thread;
    if (typeof currentThreadId !== "string" || typeof thread?.sessionId !== "string" ||
      threadStart?.model !== decision.routing.root.model ||
      threadStart?.cwd !== scope.physicalRoot ||
      !Array.isArray(threadStart?.runtimeWorkspaceRoots) ||
      !threadStart.runtimeWorkspaceRoots.includes(scope.physicalRoot)) {
      throw new Error("App Server thread/start identity mismatch");
    }

    const sandboxPolicy = writeEnabled
      ? {
          type: "workspaceWrite",
          writableRoots: scope.writeScope,
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        }
      : { type: "readOnly", networkAccess: false };
    const turnStart = await client.request("turn/start", {
      threadId: currentThreadId,
      input: [{ type: "text", text: renderTaskMessage(packet) }],
      model: decision.routing.root.model,
      effort: decision.routing.root.effort,
      cwd: scope.physicalRoot,
      runtimeWorkspaceRoots: [scope.physicalRoot],
      sandboxPolicy,
      approvalPolicy: "never",
    });
    currentTurnId = turnId(turnStart);
    if (typeof currentTurnId !== "string") throw new Error("App Server turn/start identity mismatch");
    await client.waitFor(
      "turn/started",
      (params) => threadId(params) === currentThreadId && turnId(params) === currentTurnId,
      requestTimeoutMs,
    );
    let completed;
    try {
      completed = await client.waitFor(
        "turn/completed",
        (params) => threadId(params) === currentThreadId && turnId(params) === currentTurnId,
        turnTimeoutMs,
      );
    } catch (error) {
      await client.request("turn/interrupt", {
        threadId: currentThreadId,
        turnId: currentTurnId,
      }, requestTimeoutMs);
      completed = await client.waitFor(
        "turn/completed",
        (params) => threadId(params) === currentThreadId && turnId(params) === currentTurnId,
        requestTimeoutMs,
      );
      throw error;
    }
    const completedTurn = completed?.turn;
    turnTerminal = TERMINAL_TURN_STATUSES.has(completedTurn?.status);
    if (completedTurn?.status !== "completed") {
      throw new Error("App Server turn did not complete successfully");
    }
    if (client.serverRequestObserved) {
      throw new Error("App Server requested an interactive authority expansion");
    }

    readback = await client.request("thread/read", {
      threadId: currentThreadId,
      includeTurns: true,
    });
    const persistedTurn = findTurn(readback, currentTurnId);
    if (threadId(readback) !== currentThreadId || persistedTurn?.status !== "completed") {
      throw new Error("App Server thread readback did not contain the completed turn");
    }
    runtime = await verifiedRollout({
      path: thread.path,
      codexHome,
      thread,
      route: decision.routing.root,
      cwd: scope.physicalRoot,
      taskMessage: renderTaskMessage(packet),
    });

    after = await snapshotWorkspace(scope.physicalRoot);
    changes = workspaceChanges(before, after);
    const allowedScopes = packet.writeScope.map((value) => value.split("/").join(sep));
    if (changes.some((path) => !scopeChangeAllowed(
      path,
      before,
      after,
      allowedScopes,
    ))) {
      throw new Error("App Server root provider write scope verification failed");
    }

    await client.request("thread/archive", { threadId: currentThreadId });
    archived = true;
    await client.request("thread/unsubscribe", { threadId: currentThreadId });
    unsubscribed = true;
    exit = await client.close(closeTimeoutMs);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error("App Server did not close cleanly");
    }

    const receipt = {
      schemaVersion: 1,
      kind: "gearbox-app-server-root-receipt",
      status: "pass",
      reasonCode: "APP_SERVER_ROOT_RUNTIME_VERIFIED",
      startedAt,
      completedAt: new Date().toISOString(),
      taskHash: decision.taskHash,
      policySha256: policy.sha256,
      route: decision.routing.root,
      provider: {
        kind: "app_server_root",
        transport: "stdio",
        serverVersion: discovery.serverVersion,
        threadIdSha256: sha256(currentThreadId),
        turnIdSha256: sha256(currentTurnId),
        modelProvider: readback.thread.modelProvider,
      },
      scope: {
        cwdSha256: sha256(scope.physicalRoot),
        ...appServerRootScopeBinding(packet),
        changedPathCount: changes.length,
        changes: privacySafeChanges(changes),
        verified: true,
      },
      runtime: {
        rolloutSha256: runtime.rolloutSha256,
        resultSha256: sha256((runtime.summary.finalTexts.at(-1) ?? "").trim()),
        checks: runtime.checks,
        tokenUsage: runtime.summary.tokenUsage,
      },
      lifecycle: {
        initialized: true,
        threadStarted: true,
        turnStarted: true,
        turnCompleted: true,
        readback: true,
        archived,
        unsubscribed,
        serverRequestObserved: false,
        serverExitCode: exit.code,
        serverExitSignal: exit.signal,
      },
      diagnostics: {
        stderrBytes: Buffer.byteLength(client.stderr),
        stderrSha256: sha256(client.stderr),
      },
    };
    const validation = validateAppServerRootReceipt(receipt, {
      policySha256: policy.sha256,
    });
    if (!validation.pass) {
      throw new Error("App Server runtime evidence receipt failed validation");
    }
    const persisted = await persistReceipt(targetReceiptPath, receipt);
    return {
      status: "pass",
      decision,
      receipt: { ...persisted, value: receipt },
      finalTexts: runtime.summary.finalTexts,
    };
  } catch (error) {
    if (before !== null && after === null) {
      try {
        after = await snapshotWorkspace(scope.physicalRoot);
        changes = workspaceChanges(before, after);
      } catch {
        changes = [];
      }
    }
    if (currentTurnId !== null && !turnTerminal && !client.exited) {
      try {
        await client.request("turn/interrupt", {
          threadId: currentThreadId,
          turnId: currentTurnId,
        }, requestTimeoutMs);
      } catch {
        // The failure receipt records that the lifecycle did not close cleanly.
      }
    }
    if (currentThreadId !== null && !archived && !client.exited) {
      try {
        await client.request("thread/archive", { threadId: currentThreadId }, requestTimeoutMs);
        archived = true;
      } catch {
        // Best-effort provider cleanup only.
      }
    }
    if (currentThreadId !== null && !unsubscribed && !client.exited) {
      try {
        await client.request("thread/unsubscribe", { threadId: currentThreadId }, requestTimeoutMs);
        unsubscribed = true;
      } catch {
        // Best-effort provider cleanup only.
      }
    }
    if (exit === null) exit = await client.close(closeTimeoutMs);
    const receipt = {
      schemaVersion: 1,
      kind: "gearbox-app-server-root-receipt",
      status: "fail",
      reasonCode: failureCode(error),
      startedAt,
      completedAt: new Date().toISOString(),
      taskHash: decision.taskHash,
      policySha256: policy.sha256,
      route: decision.routing.root,
      scope: {
        cwdSha256: sha256(scope.physicalRoot),
        ...appServerRootScopeBinding(packet),
        changedPathCount: changes.length,
        changes: privacySafeChanges(changes),
        verified: false,
      },
      lifecycle: {
        initialized: currentThreadId !== null,
        threadStarted: currentThreadId !== null,
        turnStarted: currentTurnId !== null,
        turnCompleted: turnTerminal,
        readback: readback !== null,
        archived,
        unsubscribed,
        serverRequestObserved: client.serverRequestObserved,
        serverExitCode: exit?.code ?? null,
        serverExitSignal: exit?.signal ?? null,
      },
      diagnostics: {
        stderrBytes: Buffer.byteLength(client.stderr),
        stderrSha256: sha256(client.stderr),
      },
    };
    const persisted = await persistReceipt(targetReceiptPath, receipt);
    return {
      status: "fail",
      decision,
      receipt: { ...persisted, value: receipt },
      finalTexts: [],
    };
  }
}
