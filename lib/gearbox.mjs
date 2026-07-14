import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  assertManagedPolicyTarget,
  createDispatchPolicy,
  DISPATCH_POLICY_RELATIVE_PATH,
  serializeDispatchPolicy,
} from "./dispatch-policy.mjs";

export const CONFIG_ROLES_MARKER = "sol-ultra-gearbox-v2:roles";
export const CONFIG_V2_MARKER = "sol-ultra-gearbox-v2:multi-agent-v2";
export const CONFIG_LEGACY_THREADS_MARKER =
  "sol-ultra-gearbox-v2:legacy-max-threads";
export const AGENTS_MARKER = "sol-ultra-gearbox-v2:workflow";
export const MAX_DIRECT_CHILDREN = 2;
export const MULTI_AGENT_SESSION_THREADS = MAX_DIRECT_CHILDREN + 1;
export const ACTIVE_ROOT_EFFORTS = Object.freeze(["max", "ultra"]);

const LEGACY_MULTI_AGENT_SESSION_THREADS = 2;

export const DISPATCH_RUNTIME_FILES = Object.freeze([
  "lib/gearbox.mjs",
  "lib/dispatch-planner.mjs",
  "lib/dispatch-policy.mjs",
  "lib/dispatch-evidence.mjs",
  "lib/dispatch-ledger.mjs",
  "lib/dispatch-runner.mjs",
  "lib/workflow-plan.mjs",
  "lib/workflow-compiler.mjs",
  "lib/workflow-state.mjs",
  "lib/workflow-scheduler.mjs",
  "lib/workflow-orchestrator.mjs",
  "lib/private-jsonl.mjs",
  "lib/workflow-ledger.mjs",
  "lib/workflow-recovery.mjs",
  "lib/workflow-outcome.mjs",
  "lib/owned-packet.mjs",
  "lib/workflow-cli.mjs",
  "scripts/gearbox-dispatch.mjs",
]);

export const RUNTIME_BINDING_FILES = Object.freeze([
  "lib/gearbox.mjs",
  "lib/runtime-evidence.mjs",
  "lib/acceptance-exam.mjs",
  "scripts/gearbox.mjs",
  "scripts/codex-typed-agent",
  ...DISPATCH_RUNTIME_FILES,
  "lib/workflow-contract-evidence.mjs",
  "scripts/workflow-contract-evidence.mjs",
  "docs/workflow-contract-evidence.json",
  "scripts/gearbox-dispatch",
].filter((path, index, paths) => paths.indexOf(path) === index));

export const WORKFLOW_CONTRACT_SOURCE_PATHS = Object.freeze([
  "lib/workflow-plan.mjs",
  "lib/workflow-compiler.mjs",
  "lib/workflow-state.mjs",
  "lib/workflow-scheduler.mjs",
  "lib/workflow-orchestrator.mjs",
  "lib/workflow-ledger.mjs",
  "lib/workflow-recovery.mjs",
  "lib/workflow-outcome.mjs",
  "tests/workflow-acceptance.test.mjs",
]);

const WORKFLOW_CONTRACT_SCENARIO_IDS = Object.freeze([
  "parallel_research_then_verify",
  "two_audits_then_writer",
  "resume_after_adopted_stage",
  "first_execution_fails_to_materialize",
  "invalid_or_out_of_scope_artifact",
]);

const WORKFLOW_CONTRACT_FIELDS = Object.freeze([
  "stageOrderPreserved",
  "selfContainedHandoff",
  "firstRealExecutionCanary",
  "futureCapacityReserved",
  "resultAdoptionExplicit",
  "typedIdentityRequired",
  "permissionsRequired",
  "runtimeEvidenceRequired",
  "resumableWithoutDuplicateWork",
  "privacySafeOutcome",
]);

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
      "Opt-in Terra Max compatibility worker. Use only when the owner explicitly requests this exact role or an existing workflow requires it; terra_worker is the normal implementation route.",
    smoke: true,
    legacy: true,
  },
  {
    name: "sol_skill_tester",
    sourceFile: "sol-skill-tester.toml",
    installFile: "sol-skill-tester.toml",
    model: "gpt-5.6-sol",
    effort: "high",
    sandbox: "read-only",
    description:
      "Isolated Sol High pressure tester for fresh-context RED/GREEN workflow-skill evaluation; never exposed as a typed child.",
    smoke: false,
    isolatedOnly: true,
  },
]);

export const CONFIG_ROLE_SPECS = Object.freeze(
  ROLE_SPECS.filter((role) => role.isolatedOnly !== true),
);

export const TYPED_ROLE_NAMES = Object.freeze(
  CONFIG_ROLE_SPECS.map((role) => role.name),
);

export function validateTypedSpawnArgs(args = {}) {
  const checks = {
    knownTypedRole: TYPED_ROLE_NAMES.includes(args.agent_type),
    forkTurnsNone: args.fork_turns === "none",
    messagePresent:
      typeof args.message === "string" && args.message.trim().length > 0,
    noModelOverride: !("model" in args),
    noEffortOverride:
      !("reasoning_effort" in args) &&
      !("model_reasoning_effort" in args),
    noServiceTierOverride: !("service_tier" in args),
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
  };
}

export const WORKFLOW_POLICY = `## Workflow and Delegation Budget

<!-- BEGIN ${AGENTS_MARKER} -->
- 預設由單一 Sol 主代理直接完成，使用足以安全交付的最輕量流程。
- 小型、局部且驗收條件清楚的修改，不建立 plan file、worktree、reviewer 或子代理。
- 只有至少兩個真正獨立、交付物明確且寫入範圍不重疊的工作，才使用 Sol Ultra 或 parallel fan-out；已知 skill adapter 可在非-Ultra root 下依序建立單一 typed child，但仍須通過 pre-spawn gate。
- 日常角色路由：機械讀取用 \`luna_clerk\`；探索蒐證用 \`terra_explorer\`；已規劃實作用 \`terra_worker\`；高風險 diff 審查用 \`sol_reviewer\`。
- Sol Max 是疑難、高風險或前後相依工作的單一 root mode，不是 child agent type；Sol Ultra 只用於至少兩個真正獨立的工作流。
- \`terra_ultra_specialist\` 只用於大型、模組級、自包含且可回滾的特例；\`terra_max_worker\` 是明確 opt-in 的相容角色，只有 owner 指定該角色或既有 workflow 依賴時使用，不作自動升級或預設路由。
- 安全、authentication、authorization、payments、schema migration、secrets、deployment、destructive 或不可逆決策一律由 Sol root 負責。
- 指定 custom agent 時，必須使用對應 \`agent_type\` 並明確設定 \`fork_turns = "none"\`；省略 model、reasoning_effort 與 service_tier，由角色 TOML 決定。
- 每個 child prompt 必須自包含目標、範圍、已知事實、限制、預期輸出、成功條件、測試與禁止事項。
- 以目前 task 實際暴露的 spawn schema 判斷 native typed-child 能力；若沒有 \`agent_type\`，禁止建立會繼承 parent model 的 untyped child。只有 \`isolatedRunnerVerified=true\` 的 Luna／Terra read-only route，以及 owner 已批准的 \`superpowers:writing-skills\` 專用 \`sol_skill_tester\` route 可使用 isolated root；其他工作由 Sol root 完成。
- 同時最多兩個 direct children，depth 固定為 1，禁止 nested subagents。
- MultiAgentV2 session slot 設為 3，因 root 會占用一格；這只允許最多兩個 direct children，不提高行為上限。
- 預設多人讀、單人寫。Read-only fan-out 與 write worker 分回合；每回合最多一個 writer，root 負責整合與最終驗證。
- Parent permission mode 會重新套到 child；不得在 \`--yolo\`、bypass permissions 或權限不符角色時啟動 delegation。
- 便宜模型只允許一次具體修正；需求模糊、hidden coupling、兩種不同失敗原因或高風險範圍出現時，立即升級給 Sol，不重複叫多個便宜 agent 投票。
- 完成後關閉 child；只有緊密相關的 follow-up 才重用既有 agent。
- 最終回覆列出角色、實際 model、effort、fork、讀寫範圍、重試／升級與結果；沒有建立 child 時使用 \`fork N/A\`；無 runtime metadata 時標記 unverified，不宣稱省額度。
- 同一任務階段只使用一個主要 workflow skill，避免重複 planning、debugging、review 或 verification 流程。
- 修復最多三輪；達到驗收標準後停止，不自行擴張功能或執行無關 cleanup。
- Reviewer 只檢查需求、diff 與測試證據，不重新探索或實作整個任務。
- 驗證範圍依風險調整；除非影響廣泛或使用者明確要求，否則不跑完整 test suite。

### Quality-first managed dispatch

- Managed routing is an instruction-and-runner control, not a Codex core hook. Unsupported direct \`spawn_agent\` calls outside this skill or \`gearbox-dispatch\` are not intercepted by this repository.
- Build one self-contained packet only when actual delegation is intended. Load the managed dispatch policy; a missing, invalid, unknown-version, hash-mismatched, or unmanaged policy means \`off\`.
- \`off\` makes no routing decision; \`shadow\` records the plan but keeps execution in the Sol root; \`active\` may execute only an approved plan. Quality gate always runs before the cost gate, and a later cheap-role signal may never reverse a quality rejection.
- Before supported actual delegation, run \`gearbox-dispatch plan\` with the packet plus separate \`agentTypeVisible\`, \`isolatedRunnerVerified\`, runtime-metadata, and parent-permission facts. Unknown skills, unavailable safe execution surfaces, generic roles, direct core calls, and missing trusted runtime evidence fail closed to \`root_inline\`.
- The only execution shapes are \`root_inline\`, \`typed_child\`, \`isolated_role_root\`, and \`typed_child_bridge\`. A verified Luna/Terra read-only route may use \`isolated_role_root\` when parent permission mismatches or native child schema is unavailable. Verified isolated route 不需要 \`agent_type\` because it is an isolated root, never a child, and it starts only through \`gearbox-dispatch run-isolated\`.
- A normal \`typed_child\` requires matching parent and role permission modes plus the typed spawn arguments. A write-permission mismatch stays \`root_inline\`. \`typed_child_bridge\` is disabled for first activation: \`allowTypedBridge=false\`; no bridge runs unless a later enabled capability and its own verified evidence exist.
- Root workflow: (1) build the packet, (2) load policy, (3) plan, (4) complete \`root_inline\` in Sol, (5) for \`typed_child\` spawn exact typed args then wait, close, and validate evidence, (6) for \`isolated_role_root\` run the isolated runner, (7) reject missing or mismatched evidence before integration, (8) on a hard active failure stop delegation and roll back only through the hash-bound policy activation manifest and managed rollback command, (9) Sol integrates, runs relevant tests, records a privacy-safe outcome, and cleans the packet.
- Verified multi-stage workflows require a validated DAG, exact artifact lineage, and schema version 2 stage packets; direct bounded work remains packet v1. Preserve reserved verification and recovery attempts.
- The first real execution is the canary. Persist its running or completed receipt before releasing another stage; evidence must pass mechanical verify, explicit Sol adopt, and provider close in that order.
- Treat the upstream workflow store as the source of truth. Use one private managed ledger only when no compatible upstream source exists; resume adopted work without rerunning it and block incomplete executions.
- Supported workflow shapes remain \`root_inline\`, \`typed_child\`, and \`isolated_role_root\`; \`app_thread_root\` is not enabled. This is not a Codex core hook.
- Each cheap role receives one initial attempt and at most one correction for a concrete local output defect. Identity, permission, scope, cleanup, policy, or ambiguity failures receive no retry and return to Sol.
- First active installation requires trusted current ten-question acceptance evidence and an applied activation manifest. The manifest path is redacted from dispatch status and public evidence; only the managed rollback command may consume it to change global state.
- Active apply 另要求 persisted fresh CLI root 為 \`gpt-5.6-sol\` 且 effort 是 Max 或 Ultra；這是 CLI quality floor，不宣稱目前 Desktop task 的 task-local mode。
- Automatic rollback 只復原先前 Gearbox-owned config blocks 並核對 pre-install hash，不儲存或覆蓋完整使用者 config；legacy recovery 只有候選內容精確符合綁定雜湊時才允許。
- Do not publish a savings percentage or estimator before ten comparable real-work root-inclusive pairs exist. \`terra_max_worker\` remains legacy opt-in only.

### Skill-driven Delegation Compatibility Gate

- Before selecting \`superpowers:executing-plans\`, check whether its written plan contains bounded phases that would otherwise select \`subagent-driven-development\`; run the Gearbox workflow-selection gate before declaring subagents unavailable.
- 當任何 workflow skill 實際準備呼叫 \`spawn_agent\`、dispatch、delegate 或 fan-out 時，先執行 Gearbox pre-spawn compatibility gate；只有文字提到 subagent、multi-agent 或 spawn 不觸發。
- Workflow skill 保留 planning、task order、review loop 與驗收語意；Gearbox 只接管 child role、spawn arguments、concurrency、permissions、write scope 與 escalation。
- 禁止以缺少 \`agent_type\` 或 \`default\`、\`general-purpose\`、\`worker\`、\`reviewer\` 等 generic type 直接建立 child；先依責任轉成已安裝 typed role。
- Generic responsibility mapping：機械盤點轉 \`luna_clerk\`；探索、research、ranking 與 evidence collection 轉 \`terra_explorer\`；已規劃且範圍獨立的 implementation 或 fixer 轉 \`terra_worker\`；requirements、diff、security boundary 與 test-evidence review 轉 \`sol_reviewer\`。
- \`executing-plans\`：保留 plan order 與 checkpoints；有 native typed child 時轉入 SDD adapter，沒有 \`agent_type\` 時仍可把通過品質門檻的 Luna／Terra read-only phase 交給 verified isolated runner。Implementation writer 在沒有 native typed capability 時仍由 Sol root 執行。
- \`subagent-driven-development\`：Sol root 保留 plan 與 progress ledger；implementer／fixer 依序使用 \`terra_worker\`；只有 parent permission 已切換並匹配 read-only 時才使用 \`sol_reviewer\`，否則由 Sol root 自行 task review；final adjudication 仍由 Sol root 負責，不平行啟動 writers。
- \`dispatching-parallel-agents\`：只處理真正獨立的工作，使用 typed roles，最多兩個 direct children 一批；read-only fan-out 與 writer 分回合。
- \`requesting-code-review\`：以 read-only \`sol_reviewer\` 接收明確 requirements、diff 與既有 test evidence；reviewer 不修改檔案，修正另交 exclusive \`terra_worker\` 或由 Sol root 處理。
- \`security-scan\` 與 \`security-diff-scan\`：ranking／evidence collection 使用 \`terra_explorer\`，validation／attack-path／security-boundary review 使用 \`sol_reviewer\`，最多兩個一批；Sol root 負責 finding 判定、write-up 與任何安全性寫入。
- \`superpowers:writing-skills\`：只有 owner approval 明確存在時，才可使用 isolated-only \`sol_skill_tester\`。RED control 與 GREEN treatment 各至少五次、全部依序執行於全新隔離 context，兩組使用相同 model、effort、task contract；只有 GREEN workspace 可包含 target skill，task 不得洩漏 expected verdict。角色不得寫檔、spawn 或繼承完整 Superpowers；Sol root 負責逐筆比較與最終判定。
- \`sites:sites-building\`、\`hatch-pet\` 與 \`heygen:heygen-video\` 是已知 root-only／owner-decision exceptions；不得以 generic role 繞過其 exact concurrency、creative verdict 或 external side-effect contract。
- Unknown skill 一律 fail closed：不要 spawn child；先由 Sol root 直接完成，或先新增並驗證明確 adapter。不得以名稱猜測、parent model inheritance 或 generic agent 當 fallback。
- Skill 若要求超過兩個同時 children、exact parallelism、nested spawn、child external side effect、權限不符或 runtime model／effort override，不得靜默改寫流程；停止 delegation，由 Sol root 採安全 fallback，必要時請 owner 決定。
- Superpowers 與其他 workflow plugins 留在 Sol root；typed children 維持窄角色與 no-delegation 設定，不在 child 重新展開完整 workflow。

### User Trigger Routing

- 未指定模式：自動採最輕量且足夠安全的流程。
- \`啟動水肥車\`：只使用既有 \`anti-slop-review\`，檢查目前變更並只修高信心問題。
- \`啟動核能水肥車\`：只在 Superpowers 已啟用的全新任務中使用完整流程；若目前未啟用，說明如何開啟新任務，不得靜默修改全域設定。
<!-- END ${AGENTS_MARKER} -->`;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactObjectKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export async function readCurrentWorkflowContractEvidence(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TypeError("workflow contract repository root must be a real directory");
  }
  const sourceManifest = [];
  for (const path of WORKFLOW_CONTRACT_SOURCE_PATHS) {
    const absolute = join(root, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError(`workflow contract source must be a regular file: ${path}`);
    }
    sourceManifest.push({ path, sha256: sha256(await readFile(absolute)) });
  }
  const artifactPath = join(root, "docs", "workflow-contract-evidence.json");
  const artifactMetadata = await lstat(artifactPath);
  if (!artifactMetadata.isFile() || artifactMetadata.isSymbolicLink()) {
    throw new TypeError("workflow contract evidence must be a regular file");
  }
  const source = await readFile(artifactPath, "utf8");
  let evidence;
  try {
    evidence = JSON.parse(source);
  } catch {
    throw new TypeError("workflow contract evidence must contain JSON");
  }
  const topLevel = ["schemaVersion", "kind", "sourceManifest", "scenarioCount", "passedScenarioCount", "scenarios"];
  const manifestValid = Array.isArray(evidence?.sourceManifest) &&
    evidence.sourceManifest.length === sourceManifest.length &&
    evidence.sourceManifest.every((entry, index) =>
      exactObjectKeys(entry, ["path", "sha256"]) &&
      entry.path === sourceManifest[index].path && entry.sha256 === sourceManifest[index].sha256,
    );
  const scenariosValid = Array.isArray(evidence?.scenarios) &&
    evidence.scenarios.length === WORKFLOW_CONTRACT_SCENARIO_IDS.length &&
    evidence.scenarios.every((row, index) =>
      exactObjectKeys(row, ["id", "pass", "contract"]) &&
      row.id === WORKFLOW_CONTRACT_SCENARIO_IDS[index] && row.pass === true &&
      exactObjectKeys(row.contract, WORKFLOW_CONTRACT_FIELDS) &&
      WORKFLOW_CONTRACT_FIELDS.every((field) => row.contract[field] === true),
    );
  if (!exactObjectKeys(evidence, topLevel) || evidence.schemaVersion !== 1 ||
    evidence.kind !== "verified_workflow_contract" || evidence.scenarioCount !== 5 ||
    evidence.passedScenarioCount !== 5 || !manifestValid || !scenariosValid) {
    throw new TypeError("workflow contract evidence is missing, stale, or invalid");
  }
  return { sha256: sha256(source), evidence };
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

function managedBlock(source, marker, comment = "#") {
  const { begin, end } = markerLines(marker, comment);
  const beginCount = countOccurrences(source, begin);
  const endCount = countOccurrences(source, end);
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error(`Malformed managed block: ${marker}`);
  }
  if (beginCount === 0) return null;
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start) + end.length;
  return source.slice(start, finish);
}

export function captureConfigRollbackState(source) {
  return {
    schemaVersion: 1,
    beforeSha256: sha256(source),
    managedBlocks: Object.fromEntries(
      [
        CONFIG_LEGACY_THREADS_MARKER,
        CONFIG_ROLES_MARKER,
        CONFIG_V2_MARKER,
      ].map((marker) => [marker, managedBlock(source, marker)]),
    ),
  };
}

function replaceManagedBlock(source, marker, previous) {
  if (previous === null) {
    return marker === CONFIG_LEGACY_THREADS_MARKER
      ? restoreLegacyMaxThreads(source)
      : stripManagedBlock(source, marker);
  }
  if (typeof previous !== "string" || managedBlock(previous, marker) !== previous) {
    throw new Error(`Invalid rollback managed block: ${marker}`);
  }
  const current = managedBlock(source, marker);
  if (current === null) {
    throw new Error(`Missing current managed block: ${marker}`);
  }
  return source.replace(current, previous);
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

  const missingRoles = CONFIG_ROLE_SPECS.filter(
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
      `[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = ${MULTI_AGENT_SESSION_THREADS}\nhide_spawn_agent_metadata = false\ntool_namespace = "agents"`,
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

export function restoreConfigRollbackState(source, {
  rollbackState = null,
  expectedSha256,
  codexHome,
  allowHashMismatch = false,
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) {
    throw new Error("Expected a valid pre-install config hash");
  }
  if (sha256(source) === expectedSha256) {
    return { source, strategy: "already_restored", exact: true };
  }

  const candidates = [];
  if (rollbackState !== null) {
    if (
      rollbackState?.schemaVersion !== 1 ||
      rollbackState?.beforeSha256 !== expectedSha256 ||
      rollbackState?.managedBlocks === null ||
      typeof rollbackState?.managedBlocks !== "object"
    ) {
      throw new Error("Invalid config rollback state");
    }
    let restored = source;
    for (const marker of [
      CONFIG_ROLES_MARKER,
      CONFIG_V2_MARKER,
      CONFIG_LEGACY_THREADS_MARKER,
    ]) {
      if (!(marker in rollbackState.managedBlocks)) {
        throw new Error(`Missing rollback managed block: ${marker}`);
      }
      restored = replaceManagedBlock(
        restored,
        marker,
        rollbackState.managedBlocks[marker],
      );
    }
    candidates.push({ source: restored, strategy: "managed_state" });
  } else {
    try {
      candidates.push({
        source: rollbackConfig(source),
        strategy: "managed_remove",
      });
    } catch {
      // Try the bounded legacy-v2 reconstruction below.
    }
    try {
      const current = renderConfig(source, codexHome, { promoteV2: true });
      const currentLine =
        `max_concurrent_threads_per_session = ${MULTI_AGENT_SESSION_THREADS}`;
      if (countOccurrences(current, currentLine) === 1) {
        candidates.push({
          source: current.replace(
            currentLine,
            `max_concurrent_threads_per_session = ${LEGACY_MULTI_AGENT_SESSION_THREADS}`,
          ),
          strategy: "legacy_v2_hash_match",
        });
      }
    } catch {
      // A legacy recovery is accepted only when a candidate matches the bound hash.
    }
  }

  const match = candidates.find(
    (candidate) => sha256(candidate.source) === expectedSha256,
  );
  if (match) return { ...match, exact: true };
  if (rollbackState !== null && allowHashMismatch && candidates.length === 1) {
    return { ...candidates[0], exact: false };
  }
  throw new Error("Unable to restore expected pre-install config hash");
}

export function validatePostInstallRootRuntime(runtime, { active = false } = {}) {
  const checks = {
    persisted: runtime?.persisted === true,
    solRoot: runtime?.model === "gpt-5.6-sol",
    effortAllowed: !active || ACTIVE_ROOT_EFFORTS.includes(runtime?.effort),
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    requiredRuntime: {
      model: "gpt-5.6-sol",
      efforts: active ? [...ACTIVE_ROOT_EFFORTS] : null,
    },
  };
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
    "finalTexts",
    "functionCalls",
    "message",
    "prompt",
    "secret",
    "sessionId",
    "sessionMeta",
    "session_id",
    "stderr",
    "stdout",
    "token",
    "turnContext",
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

async function regularFileOrAbsent(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError(`managed dispatch target must be a regular file: ${path}`);
    }
    return metadata;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readRegularSource(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError(`managed dispatch source must be a regular file: ${path}`);
  }
  return readFile(path, "utf8");
}

function dispatchRuntimeEntries({ sourceRoot, codexHome, policySource }) {
  return [
    {
      kind: "dispatch-policy",
      sourcePath: null,
      targetPath: join(codexHome, DISPATCH_POLICY_RELATIVE_PATH),
      source: policySource,
      mode: 0o600,
    },
    ...DISPATCH_RUNTIME_FILES.map((path) => ({
      kind: "dispatch-runtime",
      sourcePath: join(sourceRoot, path),
      targetPath: join(codexHome, "gearbox", "runtime", path),
      mode: 0o644,
    })),
    {
      kind: "dispatch-wrapper",
      sourcePath: join(sourceRoot, "scripts", "gearbox-dispatch"),
      targetPath: join(codexHome, "bin", "gearbox-dispatch"),
      mode: 0o755,
    },
  ];
}

export async function installDispatchRuntime({
  sourceRoot,
  codexHome,
  backupDirectory,
  dispatchMode,
  dispatchPolicy = null,
  writeTarget = atomicWrite,
}) {
  if (!["shadow", "active"].includes(dispatchMode)) {
    throw new Error("dispatch mode must be shadow or active");
  }
  if (typeof writeTarget !== "function") throw new TypeError("dispatch target writer must be a function");
  const policy = dispatchPolicy ?? (
    dispatchMode === "shadow"
      ? createDispatchPolicy({ mode: "shadow", allowTypedBridge: false, activation: null })
      : null
  );
  if (policy === null || policy.mode !== dispatchMode || policy.allowTypedBridge !== false) {
    throw new Error("active dispatch requires a hash-bound activation policy");
  }
  const policySource = serializeDispatchPolicy(policy);
  const policyTarget = join(codexHome, DISPATCH_POLICY_RELATIVE_PATH);
  const existingPolicy = await regularFileOrAbsent(policyTarget);
  if (existingPolicy !== null) assertManagedPolicyTarget(await readFile(policyTarget, "utf8"));

  const prepared = [];
  for (const entry of dispatchRuntimeEntries({ sourceRoot, codexHome, policySource })) {
    await regularFileOrAbsent(entry.targetPath);
    const source = entry.source ?? await readRegularSource(entry.sourcePath);
    prepared.push({ ...entry, source, sourceSha256: sha256(source) });
  }

  const files = [];
  for (const entry of prepared) {
    const backup = await backupFile(entry.targetPath, backupDirectory);
    files.push({
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
      sourceSha256: entry.sourceSha256,
      targetSha256: entry.sourceSha256,
      afterSha256: entry.sourceSha256,
      mode: entry.mode,
      policyMode: entry.kind === "dispatch-policy" ? policy.mode : null,
      backup,
      removeOnRollback: true,
    });
  }

  const applied = [];
  try {
    for (let index = 0; index < prepared.length; index += 1) {
      const entry = prepared[index];
      const file = files[index];
      applied.push(file);
      await writeTarget(entry.targetPath, entry.source, entry.mode);
      const installed = await regularFileOrAbsent(entry.targetPath);
      const targetSha256 = sha256(await readFile(entry.targetPath));
      if (installed === null || (installed.mode & 0o777) !== entry.mode) {
        throw new Error(`managed dispatch target mode readback failed: ${entry.targetPath}`);
      }
      if (targetSha256 !== entry.sourceSha256) {
        throw new Error(`managed dispatch target hash readback failed: ${entry.targetPath}`);
      }
      file.targetSha256 = targetSha256;
      file.afterSha256 = targetSha256;
    }
  } catch (error) {
    try {
      await rollbackDispatchRuntime({
        manifest: { schemaVersion: 1, codexHome, files: applied },
        force: true,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `dispatch install failed and automatic rollback failed: ${error.message}`,
      );
    }
    throw error;
  }
  return { schemaVersion: 1, codexHome, policyMode: policy.mode, files };
}

async function removeEmptyDispatchParents(path, codexHome) {
  const root = resolve(codexHome);
  let current = dirname(path);
  while (current.startsWith(`${root}/`) && current !== root) {
    try {
      await rmdir(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      break;
    }
    current = dirname(current);
  }
}

export async function rollbackDispatchRuntime({ manifest, force = false }) {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new TypeError("dispatch runtime rollback requires an install manifest");
  }
  if (!force) {
    for (const entry of manifest.files) {
      const metadata = await regularFileOrAbsent(entry.targetPath);
      if (metadata === null || (metadata.mode & 0o777) !== entry.mode) {
        throw new Error(`managed dispatch target mode drift: ${entry.targetPath}`);
      }
      if (sha256(await readFile(entry.targetPath, "utf8")) !== entry.targetSha256) {
        throw new Error(`managed dispatch target content drift: ${entry.targetPath}`);
      }
    }
  }
  for (const entry of [...manifest.files].reverse()) {
    if (entry.backup.existed) {
      await atomicWrite(
        entry.targetPath,
        await readFile(entry.backup.backupPath, "utf8"),
        entry.backup.mode,
      );
      continue;
    }
    try {
      await unlink(entry.targetPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await removeEmptyDispatchParents(entry.targetPath, manifest.codexHome);
  }
  return { rolledBack: true };
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

const OWNED_PROBE_DIRECTORY =
  /^sol-ultra-gearbox-v2-(?:(?:home-)?(?:luna_clerk|terra_explorer|terra_worker|sol_reviewer|terra_ultra_specialist|terra_max_worker|sol_skill_tester)|sdd|writing-skills-(?:red|green)|dispatch-(?:luna_clerk|terra_explorer|sol_skill_tester)|dispatch-home-(?:luna_clerk|terra_explorer|sol_skill_tester)|scope-dispatch|packet-dispatch)-[A-Za-z0-9]+$/;

export async function cleanupProbeArtifacts(paths) {
  const root = resolve(tmpdir());
  const removed = [];
  for (const path of paths) {
    const absolute = resolve(path);
    if (
      dirname(absolute) !== root ||
      !OWNED_PROBE_DIRECTORY.test(basename(absolute))
    ) {
      throw new Error(`Refusing to remove non-Gearbox probe path: ${path}`);
    }
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-directory probe path: ${path}`);
    }
    await rm(absolute, { recursive: true, force: false });
    removed.push(basename(absolute));
  }
  return { removed };
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

function showsRunningOrCompletedStatus(value) {
  if (Array.isArray(value)) return value.some((entry) => showsRunningOrCompletedStatus(entry));
  if (!value || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "status" || key === "agent_status") {
      if (entry === "running" || entry === "completed") return true;
      if (entry && typeof entry === "object" && !Array.isArray(entry) &&
        (Object.hasOwn(entry, "running") || Object.hasOwn(entry, "completed"))) return true;
    }
    if (showsRunningOrCompletedStatus(entry)) return true;
  }
  return false;
}

export async function summarizeRollout(path) {
  const events = parseJsonLines(await readFile(path, "utf8"));
  let sessionMeta = null;
  let turnContext = null;
  let tokenUsage = null;
  const functionCalls = [];
  const toolTimeline = [];
  const callsById = new Map();
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
        const callIndex = functionCalls.length;
        const callId = item.call_id ?? item.callId ?? item.id ?? null;
        const call = { name: item.name, args, callIndex };
        functionCalls.push(call);
        toolTimeline.push({ name: item.name, callIndex, outputPresent: false, outputSha256: null, runningOrCompleted: false });
        if (typeof callId === "string" && callId.length > 0) callsById.set(callId, callIndex);
      }
      if (item?.type === "function_call_output") {
        const callId = item.call_id ?? item.callId ?? item.id ?? null;
        const callIndex = typeof callId === "string" ? callsById.get(callId) : undefined;
        if (Number.isInteger(callIndex)) {
          const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null);
          const timeline = toolTimeline[callIndex];
          timeline.outputPresent = true;
          timeline.outputSha256 = sha256(output);
          if (timeline.name?.endsWith("list_agents")) {
            try {
              const parsed = JSON.parse(output);
              timeline.runningOrCompleted = showsRunningOrCompletedStatus(parsed);
            } catch {
              timeline.runningOrCompleted = false;
            }
          }
        }
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
  return {
    path,
    sessionMeta,
    turnContext,
    functionCalls,
    toolTimeline,
    finalTexts,
    tokenUsage,
    threadSource: sessionMeta?.thread_source ?? null,
    sessionId: sessionMeta?.id ?? sessionMeta?.session_id ?? null,
  };
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

export function verifyProbe({ spec, parent, child, marker, parentExpected }) {
  const spawnCalls = (parent?.functionCalls ?? []).filter((call) =>
    call.name?.endsWith("spawn_agent"),
  );
  const spawnArgs = spawnCalls[0]?.args ?? {};
  const spawnValidation = validateTypedSpawnArgs(spawnArgs);
  const childSpawnCalls = (child?.functionCalls ?? []).filter((call) =>
    call.name?.endsWith("spawn_agent"),
  );
  const actual = {
    parentModel: parent?.turnContext?.model ?? null,
    parentEffort: parent?.turnContext?.effort ?? null,
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
    parentModelMatches:
      Boolean(parentExpected?.model) &&
      actual.parentModel === parentExpected.model,
    parentEffortMatches:
      Boolean(parentExpected?.effort) &&
      actual.parentEffort === parentExpected.effort,
    exactlyOneSpawn: spawnCalls.length === 1,
    typedRoleRequested:
      spawnValidation.checks.knownTypedRole &&
      spawnArgs.agent_type === spec.name,
    forkTurnsNone: spawnValidation.checks.forkTurnsNone,
    taskMessagePresent: spawnValidation.checks.messagePresent,
    noModelOverride: spawnValidation.checks.noModelOverride,
    noEffortOverride: spawnValidation.checks.noEffortOverride,
    noServiceTierOverride: spawnValidation.checks.noServiceTierOverride,
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
      parentModel: parentExpected?.model ?? null,
      parentEffort: parentExpected?.effort ?? null,
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
