import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

export const CONFIG_ROLES_MARKER = "sol-ultra-gearbox-v2:roles";
export const CONFIG_V2_MARKER = "sol-ultra-gearbox-v2:multi-agent-v2";
export const CONFIG_LEGACY_THREADS_MARKER =
  "sol-ultra-gearbox-v2:legacy-max-threads";
export const AGENTS_MARKER = "sol-ultra-gearbox-v2:workflow";

export const ROLE_SPECS = Object.freeze([
  {
    name: "luna_clerk",
    sourceFile: "luna-clerk.toml",
    installFile: "luna-clerk.toml",
    model: "gpt-5.6-luna",
    effort: "low",
    sandbox: "read-only",
    description:
      "Read-only Luna clerk for deterministic inventory, extraction, classification, transformation, and mechanical checks.",
    smoke: true,
  },
  {
    name: "terra_explorer",
    sourceFile: "terra-explorer.toml",
    installFile: "terra-explorer.toml",
    model: "gpt-5.6-terra",
    effort: "medium",
    sandbox: "read-only",
    description:
      "Read-only Terra explorer for code paths, logs, documentation, tests, and evidence collection.",
    smoke: true,
  },
  {
    name: "terra_worker",
    sourceFile: "terra-worker.toml",
    installFile: "terra-worker.toml",
    model: "gpt-5.6-terra",
    effort: "high",
    sandbox: "workspace-write",
    description:
      "Terra High implementation worker for planned, bounded changes with an explicit and exclusive write scope.",
    smoke: true,
  },
  {
    name: "sol_reviewer",
    sourceFile: "sol-reviewer.toml",
    installFile: "sol-reviewer.toml",
    model: "gpt-5.6-sol",
    effort: "high",
    sandbox: "read-only",
    description:
      "Read-only Sol reviewer for requirement, diff, regression, security-boundary, and test-evidence review.",
    smoke: true,
  },
  {
    name: "terra_ultra_specialist",
    sourceFile: "terra-ultra-specialist.toml",
    installFile: "terra-ultra-specialist.toml",
    model: "gpt-5.6-terra",
    effort: "ultra",
    sandbox: "workspace-write",
    description:
      "Exceptional Terra Ultra specialist for large, module-scale, self-contained work with a safe rollback path.",
    smoke: true,
  },
  {
    name: "terra_max_worker",
    sourceFile: "terra-max-worker.toml",
    installFile: "terra-max-worker.toml",
    model: "gpt-5.6-terra",
    effort: "max",
    sandbox: "workspace-write",
    description:
      "Legacy Terra Max compatibility worker. Use only when explicitly requested; terra_worker is the normal implementation route.",
    smoke: false,
    legacy: true,
  },
]);

export const WORKFLOW_POLICY = `## Workflow and Delegation Budget

<!-- BEGIN ${AGENTS_MARKER} -->
- 預設由單一 Sol 主代理直接完成，使用足以安全交付的最輕量流程。
- 小型、局部且驗收條件清楚的修改，不建立 plan file、worktree、reviewer 或子代理。
- 只有至少兩個真正獨立、交付物明確且寫入範圍不重疊的工作，才使用 Ultra 或 multi-agent delegation。
- 日常角色路由：機械讀取用 \`luna_clerk\`；探索蒐證用 \`terra_explorer\`；已規劃實作用 \`terra_worker\`；高風險 diff 審查用 \`sol_reviewer\`。
- \`terra_ultra_specialist\` 只用於大型、模組級、自包含且可回滾的特例；\`terra_max_worker\` 僅保留舊流程相容，不作預設路由。
- 安全、authentication、authorization、payments、schema migration、secrets、deployment、destructive 或不可逆決策一律由 Sol root 負責。
- 指定 custom agent 時，必須使用對應 \`agent_type\` 並明確設定 \`fork_turns = "none"\`；省略 model、reasoning_effort 與 service_tier，由角色 TOML 決定。
- 每個 child prompt 必須自包含目標、範圍、已知事實、限制、預期輸出、成功條件、測試與禁止事項。
- 以目前 task 實際暴露的 spawn schema 判斷 typed-role 能力；若沒有 \`agent_type\`，禁止建立會繼承 parent model 的 untyped child，改由 Sol root 直接完成。
- 同時最多兩個 direct children，depth 固定為 1，禁止 nested subagents。
- 預設多人讀、單人寫。Read-only fan-out 與 write worker 分回合；每回合最多一個 writer，root 負責整合與最終驗證。
- Parent permission mode 會重新套到 child；不得在 \`--yolo\`、bypass permissions 或權限不符角色時啟動 delegation。
- 便宜模型只允許一次具體修正；需求模糊、hidden coupling、兩種不同失敗原因或高風險範圍出現時，立即升級給 Sol，不重複叫多個便宜 agent 投票。
- 完成後關閉 child；只有緊密相關的 follow-up 才重用既有 agent。
- 最終回覆列出角色、實際 model、effort、fork、讀寫範圍、重試／升級與結果；無 runtime metadata 時標記 unverified，不宣稱省額度。
- 同一任務階段只使用一個主要 workflow skill，避免重複 planning、debugging、review 或 verification 流程。
- 修復最多三輪；達到驗收標準後停止，不自行擴張功能或執行無關 cleanup。
- Reviewer 只檢查需求、diff 與測試證據，不重新探索或實作整個任務。
- 驗證範圍依風險調整；除非影響廣泛或使用者明確要求，否則不跑完整 test suite。

### User Trigger Routing

- 未指定模式：自動採最輕量且足夠安全的流程。
- \`啟動水肥車\`：只使用既有 \`anti-slop-review\`，檢查目前變更並只修高信心問題。
- \`啟動核能水肥車\`：只在 Superpowers 已啟用的全新任務中使用完整流程；若目前未啟用，說明如何開啟新任務，不得靜默修改全域設定。
<!-- END ${AGENTS_MARKER} -->`;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ensureTrailingNewline(value) {
  return `${value.trimEnd()}\n`;
}

function markerLines(marker, comment = "#") {
  return {
    begin: `${comment} >>> ${marker}`,
    end: `${comment} <<< ${marker}`,
  };
}

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripManagedBlock(source, marker, comment = "#") {
  const { begin, end } = markerLines(marker, comment);
  const beginCount = countOccurrences(source, begin);
  const endCount = countOccurrences(source, end);
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error(`Malformed managed block: ${marker}`);
  }
  if (beginCount === 0) return source;
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start) + end.length;
  const before = source.slice(0, start).trimEnd();
  const after = source.slice(finish).trimStart();
  return ensureTrailingNewline([before, after].filter(Boolean).join("\n\n"));
}

function appendManagedBlock(source, marker, body, comment = "#") {
  const { begin, end } = markerLines(marker, comment);
  return ensureTrailingNewline(
    `${source.trimEnd()}\n\n${begin}\n${body.trim()}\n${end}`,
  );
}

function escapeTomlString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function findTopLevelTable(source, table) {
  return new RegExp(`^\\[${table.replaceAll(".", "\\.")}\\]$`, "m").test(
    source,
  );
}

function validateAgentLimits(source) {
  const heading = source.match(/^\[agents\]\s*$/m);
  if (!heading || heading.index === undefined) {
    throw new Error("Expected an [agents] table in config.toml");
  }
  const bodyStart = heading.index + heading[0].length;
  const remainder = source.slice(bodyStart);
  const nextTable = remainder.search(/^\[/m);
  const body = nextTable < 0 ? remainder : remainder.slice(0, nextTable);
  const maxThreadAssignments = [
    ...body.matchAll(/^max_threads\s*=\s*([^\n#]+)\s*$/gm),
  ];
  if (maxThreadAssignments.length > 1) {
    throw new Error("Expected at most one agents.max_threads assignment");
  }
  if (
    maxThreadAssignments.length === 1 &&
    !/^[1-9]\d*$/.test(maxThreadAssignments[0][1].trim())
  ) {
    throw new Error("Expected agents.max_threads to be a positive integer");
  }
  const depthAssignments = [...body.matchAll(/^max_depth\s*=\s*1\s*$/gm)];
  if (depthAssignments.length !== 1) {
    throw new Error("Expected agents.max_depth = 1");
  }
}

function restoreLegacyMaxThreads(source) {
  const { begin, end } = markerLines(CONFIG_LEGACY_THREADS_MARKER);
  const beginCount = countOccurrences(source, begin);
  const endCount = countOccurrences(source, end);
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error(`Malformed managed block: ${CONFIG_LEGACY_THREADS_MARKER}`);
  }
  if (beginCount === 0) return source;
  const pattern = new RegExp(
    `${escapeRegExp(begin)}\\n# multi_agent_v2 owns its concurrent-thread limit\\.\\n# original: (max_threads\\s*=\\s*[1-9]\\d*\\s*)\\n${escapeRegExp(end)}`,
  );
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Unexpected managed block: ${CONFIG_LEGACY_THREADS_MARKER}`);
  }
  return source.replace(match[0], match[1].trimEnd());
}

function suspendLegacyMaxThreads(source) {
  const { begin, end } = markerLines(CONFIG_LEGACY_THREADS_MARKER);
  if (source.includes(begin) || source.includes(end)) {
    throw new Error(`Unexpected pre-existing marker: ${CONFIG_LEGACY_THREADS_MARKER}`);
  }
  const assignments = [
    ...source.matchAll(/^max_threads\s*=\s*[1-9]\d*\s*$/gm),
  ];
  if (assignments.length === 0) return source;
  if (assignments.length > 1) {
    throw new Error("Expected at most one agents.max_threads assignment");
  }
  const original = assignments[0][0].trimEnd();
  return source.replace(
    assignments[0][0],
    `${begin}\n# multi_agent_v2 owns its concurrent-thread limit.\n# original: ${original}\n${end}`,
  );
}

export function renderConfig(source, codexHome, { promoteV2 = true } = {}) {
  let base = stripManagedBlock(source, CONFIG_ROLES_MARKER);
  base = stripManagedBlock(base, CONFIG_V2_MARKER);
  base = restoreLegacyMaxThreads(base);
  validateAgentLimits(base);

  if (findTopLevelTable(base, "features.multi_agent_v2")) {
    throw new Error(
      "An unmanaged [features.multi_agent_v2] table already exists; refusing to merge blindly",
    );
  }

  const missingRoles = ROLE_SPECS.filter(
    (role) => !findTopLevelTable(base, `agents.${role.name}`),
  );
  if (missingRoles.length > 0) {
    const roleBody = missingRoles
      .map((role) => {
        const configFile = join(codexHome, "agents", role.installFile);
        return [
          `[agents.${role.name}]`,
          `description = "${escapeTomlString(role.description)}"`,
          `config_file = "${escapeTomlString(configFile)}"`,
        ].join("\n");
      })
      .join("\n\n");
    base = appendManagedBlock(base, CONFIG_ROLES_MARKER, roleBody);
  }

  if (promoteV2) {
    base = suspendLegacyMaxThreads(base);
    base = appendManagedBlock(
      base,
      CONFIG_V2_MARKER,
      `[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 2\nhide_spawn_agent_metadata = false\ntool_namespace = "agents"`,
    );
  }
  return ensureTrailingNewline(base);
}

export function rollbackConfig(source) {
  return restoreLegacyMaxThreads(
    stripManagedBlock(
      stripManagedBlock(source, CONFIG_V2_MARKER),
      CONFIG_ROLES_MARKER,
    ),
  );
}

export function removeOwnedSmokeProjectEntries(source) {
  const paths = [];
  const pattern =
    /^\[projects\."([^"\n]*\/sol-ultra-gearbox-v2-(?:terra_worker|terra_ultra_specialist)-[^"\n]+)"\]\ntrust_level = "trusted"\n\n?/gm;
  const cleaned = source.replace(pattern, (_block, path) => {
    paths.push(path);
    return "";
  });
  return {
    source: ensureTrailingNewline(cleaned),
    paths,
  };
}

function hasAgentsManagedBlock(source) {
  return (
    source.includes(`<!-- BEGIN ${AGENTS_MARKER} -->`) &&
    source.includes(`<!-- END ${AGENTS_MARKER} -->`)
  );
}

export function renderAgentsMd(source) {
  const normalized = ensureTrailingNewline(source);
  if (hasAgentsManagedBlock(normalized)) {
    const start = normalized.lastIndexOf("## Workflow and Delegation Budget");
    const endMarker = `<!-- END ${AGENTS_MARKER} -->`;
    const finish = normalized.indexOf(endMarker, start);
    if (start < 0 || finish < 0) {
      throw new Error("Malformed managed workflow section in AGENTS.md");
    }
    const afterStart = finish + endMarker.length;
    return ensureTrailingNewline(
      `${normalized.slice(0, start).trimEnd()}\n\n${WORKFLOW_POLICY}${normalized.slice(afterStart)}`,
    );
  }

  const heading = "## Workflow and Delegation Budget";
  const start = normalized.indexOf(heading);
  if (start < 0) {
    return ensureTrailingNewline(`${normalized.trimEnd()}\n\n${WORKFLOW_POLICY}`);
  }
  const nextHeading = normalized.indexOf("\n## ", start + heading.length);
  const finish = nextHeading < 0 ? normalized.length : nextHeading + 1;
  return ensureTrailingNewline(
    `${normalized.slice(0, start).trimEnd()}\n\n${WORKFLOW_POLICY}\n\n${normalized.slice(finish).trimStart()}`,
  );
}

function extractTomlString(source, key) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"));
  return match?.[1] ?? null;
}

export function validateRoleText(spec, source) {
  const checks = {
    name: extractTomlString(source, "name") === spec.name,
    model: extractTomlString(source, "model") === spec.model,
    effort:
      extractTomlString(source, "model_reasoning_effort") === spec.effort,
    sandbox: extractTomlString(source, "sandbox_mode") === spec.sandbox,
    noDelegation:
      /Never spawn, delegate to, or request another agent\./.test(source),
    rootInstructions:
      source.indexOf("developer_instructions") >= 0 &&
      source.indexOf("developer_instructions") <
        source.indexOf('[plugins."superpowers@openai-curated"]'),
    superpowersDisabled:
      /\[plugins\."superpowers@openai-curated"\]\s*\nenabled\s*=\s*false/m.test(
        source,
      ),
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
  };
}

export function redactSensitive(value) {
  const sensitiveKeys = new Set([
    "apiKey",
    "auth",
    "authHeader",
    "configSource",
    "agentsSource",
    "cookie",
    "credential",
    "message",
    "prompt",
    "secret",
    "stderr",
    "stdout",
    "token",
  ]);
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sensitiveKeys.has(key) ? "[REDACTED]" : redactSensitive(child),
      ]),
    );
  }
  return value;
}

export async function atomicWrite(path, value, mode = 0o644) {
  const temporary = `${path}.gearbox-tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, value, { encoding: "utf8", mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Best-effort cleanup only. Never preserve a failed full-config write.
    }
    throw error;
  }
}

export async function writeJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(redactSensitive(value), null, 2)}\n`);
}

export async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function backupFile(path, backupDir) {
  const source = await readOptional(path);
  if (source === null) return { path, existed: false, sha256: null };
  const backupPath = join(backupDir, basename(path));
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await copyFile(path, backupPath);
  const mode = (await stat(path)).mode & 0o777;
  await chmod(backupPath, mode);
  return { path, existed: true, backupPath, sha256: sha256(source), mode };
}

export async function restoreBackup(entry, disabledSuffix) {
  if (entry.existed) {
    const source = await readFile(entry.backupPath, "utf8");
    await atomicWrite(entry.path, source, entry.mode ?? 0o644);
    return { path: entry.path, action: "restored" };
  }
  const source = await readOptional(entry.path);
  if (source === null) return { path: entry.path, action: "already_absent" };
  const disabledPath = `${entry.path}.disabled.${disabledSuffix}`;
  await rename(entry.path, disabledPath);
  return { path: entry.path, action: "disabled", disabledPath };
}

async function walkFiles(root, predicate = () => true) {
  const output = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && predicate(path)) output.push(path);
    }
  }
  await walk(root);
  return output;
}

export async function hashTree(root) {
  const files = await walkFiles(root);
  const result = {};
  for (const path of files.sort()) {
    result[relative(root, path)] = sha256(await readFile(path));
  }
  return result;
}

function parseJsonLines(source) {
  const output = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      output.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return output;
}

export async function summarizeRollout(path) {
  const events = parseJsonLines(await readFile(path, "utf8"));
  let sessionMeta = null;
  let turnContext = null;
  let tokenUsage = null;
  const functionCalls = [];
  const finalTexts = [];
  for (const event of events) {
    if (event.type === "session_meta") sessionMeta = event.payload;
    if (event.type === "turn_context") turnContext = event.payload;
    if (event.type === "response_item") {
      const item = event.payload;
      if (item?.type === "function_call") {
        let args = null;
        try {
          args = JSON.parse(item.arguments);
        } catch {
          args = null;
        }
        functionCalls.push({ name: item.name, args });
      }
      if (item?.type === "message" && item.role === "assistant") {
        for (const content of item.content ?? []) {
          if (content?.type === "output_text" && content.text.length < 4000) {
            finalTexts.push(content.text);
          }
        }
      }
    }
    if (event.type === "event_msg" && event.payload?.type === "agent_message") {
      if (typeof event.payload.message === "string") {
        finalTexts.push(event.payload.message.slice(0, 4000));
      }
    }
    if (event.type === "event_msg" && event.payload?.type === "token_count") {
      tokenUsage = event.payload.info?.total_token_usage ?? tokenUsage;
    }
  }
  return { path, sessionMeta, turnContext, functionCalls, finalTexts, tokenUsage };
}

export async function findRecentRollouts(sessionRoot, sinceMs) {
  const files = await walkFiles(sessionRoot, (path) => path.endsWith(".jsonl"));
  const recent = [];
  for (const path of files) {
    const metadata = await lstat(path);
    if (metadata.mtimeMs >= sinceMs - 60_000) recent.push(path);
  }
  return recent;
}

export async function findProbeRollouts({ sessionRoot, cwd, sinceMs }) {
  const candidates = await findRecentRollouts(sessionRoot, sinceMs);
  const summaries = [];
  for (const path of candidates) {
    const summary = await summarizeRollout(path);
    if (summary.sessionMeta?.cwd === cwd) summaries.push(summary);
  }
  const parent = summaries.find(
    (summary) => summary.sessionMeta?.thread_source !== "subagent",
  );
  if (!parent) return { parent: null, child: null, summaries };
  const parentId = parent.sessionMeta?.id ?? parent.sessionMeta?.session_id;
  const child = summaries.find((summary) => {
    const spawn = summary.sessionMeta?.source?.subagent?.thread_spawn;
    return spawn?.parent_thread_id === parentId;
  });
  return { parent, child: child ?? null, summaries };
}

function childRole(summary) {
  return (
    summary?.sessionMeta?.agent_role ??
    summary?.sessionMeta?.source?.subagent?.thread_spawn?.agent_role ??
    null
  );
}

function childDepth(summary) {
  return summary?.sessionMeta?.source?.subagent?.thread_spawn?.depth ?? null;
}

export function verifyProbe({ spec, parent, child, marker }) {
  const spawnCalls = (parent?.functionCalls ?? []).filter((call) =>
    call.name?.endsWith("spawn_agent"),
  );
  const spawnArgs = spawnCalls[0]?.args ?? {};
  const childSpawnCalls = (child?.functionCalls ?? []).filter((call) =>
    call.name?.endsWith("spawn_agent"),
  );
  const actual = {
    role: childRole(child),
    model: child?.turnContext?.model ?? null,
    effort: child?.turnContext?.effort ?? null,
    sandbox: child?.turnContext?.sandbox_policy?.type ?? null,
    depth: childDepth(child),
    parentTokenUsage: parent?.tokenUsage ?? null,
    tokenUsage: child?.tokenUsage ?? null,
  };
  const checks = {
    parentPersisted: Boolean(parent?.sessionMeta),
    childPersisted: Boolean(child?.sessionMeta),
    exactlyOneSpawn: spawnCalls.length === 1,
    typedRoleRequested: spawnArgs.agent_type === spec.name,
    forkTurnsNone: spawnArgs.fork_turns === "none",
    noModelOverride: !("model" in spawnArgs),
    noEffortOverride:
      !("reasoning_effort" in spawnArgs) &&
      !("model_reasoning_effort" in spawnArgs),
    noServiceTierOverride: !("service_tier" in spawnArgs),
    roleMatches: actual.role === spec.name,
    modelMatches: actual.model === spec.model,
    effortMatches: actual.effort === spec.effort,
    sandboxMatches: actual.sandbox === spec.sandbox,
    depthOne: actual.depth === 1,
    noDescendantSpawn: childSpawnCalls.length === 0,
    parentTokenUsagePersisted: Number.isFinite(
      actual.parentTokenUsage?.total_tokens,
    ),
    tokenUsagePersisted: Number.isFinite(actual.tokenUsage?.total_tokens),
    markerReturned: (child?.finalTexts ?? []).some((text) => text.includes(marker)),
  };
  return {
    role: spec.name,
    pass: Object.values(checks).every(Boolean),
    expected: {
      model: spec.model,
      effort: spec.effort,
      sandbox: spec.sandbox,
      depth: 1,
      forkTurns: "none",
    },
    actual,
    checks,
  };
}
