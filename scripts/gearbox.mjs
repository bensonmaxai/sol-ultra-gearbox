#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS_MARKER,
  CONFIG_LEGACY_THREADS_MARKER,
  CONFIG_ROLES_MARKER,
  CONFIG_V2_MARKER,
  ROLE_SPECS,
  atomicWrite,
  backupFile,
  cleanupProbeArtifacts,
  findProbeRollouts,
  hashTree,
  readOptional,
  redactSensitive,
  removeOwnedSmokeProjectEntries,
  renderAgentsMd,
  renderConfig,
  restoreBackup,
  rollbackConfig,
  sha256,
  validateRoleText,
  verifyProbe,
  writeJson,
} from "../lib/gearbox.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const APP_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_BIN =
  process.env.CODEX_BIN ?? (existsSync(APP_CODEX_BIN) ? APP_CODEX_BIN : "codex");

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function rolePath(spec) {
  return join(REPO_ROOT, "roles", spec.sourceFile);
}

function installedRolePath(spec) {
  return join(CODEX_HOME, "agents", spec.installFile);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function runCommand(
  command,
  args,
  { cwd = REPO_ROOT, timeoutMs = 600_000, env = {} } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? -1,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function parseJsonObject(output) {
  const start = output.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

function safeErrorSummary(output) {
  return output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /\b(authorization|bearer|api[_-]?key|token|secret|password)\b\s*[:=]?\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .trim()
    .slice(-4000);
}

async function runDoctor() {
  const roleChecks = [];
  for (const spec of ROLE_SPECS) {
    const source = await readFile(rolePath(spec), "utf8");
    roleChecks.push({ role: spec.name, ...validateRoleText(spec, source) });
  }

  const modelCachePath = join(CODEX_HOME, "models_cache.json");
  const modelCache = JSON.parse(await readFile(modelCachePath, "utf8"));
  const modelChecks = ROLE_SPECS.map((role) => {
    const model = modelCache.models?.find((candidate) => candidate.slug === role.model);
    const efforts = model?.supported_reasoning_levels?.map((item) => item.effort) ?? [];
    return {
      role: role.name,
      model: role.model,
      effort: role.effort,
      supportedEfforts: efforts,
      present: Boolean(model),
      effortSupported: efforts.includes(role.effort),
      multiAgentVersion: model?.multi_agent_version ?? null,
    };
  });

  const configPath = join(CODEX_HOME, "config.toml");
  const configSource = await readFile(configPath, "utf8");
  let patchable = true;
  let patchError = null;
  try {
    renderConfig(configSource, CODEX_HOME, { promoteV2: true });
  } catch (error) {
    patchable = false;
    patchError = error.message;
  }

  const strictArgs = [
    "--strict-config",
    "-c",
    "features.multi_agent_v2.enabled=true",
    "-c",
    "features.multi_agent_v2.max_concurrent_threads_per_session=2",
    "-c",
    "features.multi_agent_v2.hide_spawn_agent_metadata=false",
    "-c",
    'features.multi_agent_v2.tool_namespace="agents"',
  ];
  for (const spec of ROLE_SPECS) {
    strictArgs.push(
      "-c",
      `agents.${spec.name}.description=${JSON.stringify(spec.description)}`,
      "-c",
      `agents.${spec.name}.config_file=${JSON.stringify(rolePath(spec))}`,
    );
  }
  strictArgs.push("--version");
  const strictResult = await runCommand(CODEX_BIN, strictArgs);
  const featuresResult = await runCommand(CODEX_BIN, ["features", "list"]);
  const codexDoctorResult = await runCommand(CODEX_BIN, ["doctor", "--json"], {
    timeoutMs: 120_000,
  });
  const codexDoctor = parseJsonObject(codexDoctorResult.stdout);
  const requiredDoctorChecks = ["config.load", "mcp.config", "installation"];
  const doctorChecks = Object.fromEntries(
    requiredDoctorChecks.map((name) => [
      name,
      codexDoctor?.checks?.[name]?.status === "ok",
    ]),
  );

  const checks = {
    roleFiles: roleChecks.every((item) => item.pass),
    modelCatalog: modelChecks.every(
      (item) => item.present && item.effortSupported,
    ),
    configPatchable: patchable,
    strictConfig:
      strictResult.code === 0 && strictResult.stdout.includes("codex-cli"),
    stableMultiAgent:
      featuresResult.code === 0 &&
      /^multi_agent\s+stable\s+true$/m.test(featuresResult.stdout),
    experimentalV2Known:
      featuresResult.code === 0 &&
      /^multi_agent_v2\s+under development\s+(true|false)$/m.test(
        featuresResult.stdout,
      ),
    codexDoctor: Object.values(doctorChecks).every(Boolean),
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pass: Object.values(checks).every(Boolean),
    checks,
    roleChecks,
    modelChecks,
    config: {
      path: configPath,
      sha256: sha256(configSource),
      patchable,
      patchError,
      v2Managed: configSource.includes(CONFIG_V2_MARKER),
      rolesManaged: configSource.includes(CONFIG_ROLES_MARKER),
    },
    runtime: {
      codexBin: CODEX_BIN,
      strictConfigVersion:
        strictResult.code === 0 ? strictResult.stdout.trim().split(/\r?\n/).at(-1) : null,
      doctorChecks,
      doctorOverallStatus: codexDoctor?.overallStatus ?? "unavailable",
      terminalOnlyFailure:
        codexDoctor?.overallStatus === "fail" &&
        codexDoctor?.checks?.["terminal.env"]?.status === "fail" &&
        requiredDoctorChecks.every(
          (name) => codexDoctor?.checks?.[name]?.status === "ok",
        ),
    },
  };
}

async function createProbeFixture(spec) {
  const cwd = await mkdtemp(join(tmpdir(), `sol-ultra-gearbox-v2-${spec.name}-`));
  let task;
  if (spec.name === "luna_clerk") {
    await writeFile(join(cwd, "inventory.txt"), "bravo\nalpha\ncharlie\n", "utf8");
    task =
      "Read inventory.txt with a read-only command. Confirm it has exactly three non-empty lines. Do not edit or create files. Do not spawn another agent.";
  } else if (spec.name === "terra_explorer") {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "example.js"),
      "export function gearboxProbe() { return 42; }\n",
      "utf8",
    );
    task =
      "Inspect src/example.js and identify the exported symbol and returned value. Do not edit or create files. Do not spawn another agent.";
  } else if (spec.name === "terra_worker") {
    await writeFile(join(cwd, "worker-target.txt"), "BEFORE\n", "utf8");
    task =
      "Use apply_patch to change only worker-target.txt from BEFORE to AFTER, then verify the exact content. Do not touch any other file. Do not spawn another agent.";
  } else if (spec.name === "sol_reviewer") {
    await writeFile(
      join(cwd, "review.diff"),
      "-const RETRY_LIMIT = 3;\n+const RETRY_LIMIT = -1;\n",
      "utf8",
    );
    task =
      "Review review.diff and identify the concrete behavioral risk. Do not edit or create files. Do not spawn another agent.";
  } else if (spec.name === "terra_ultra_specialist") {
    await writeFile(
      join(cwd, "specialist.txt"),
      "constraint: no descendant agents\nanswer: bounded\n",
      "utf8",
    );
    task =
      "Read specialist.txt and confirm both key-value pairs. Do not edit or create files. Do not spawn another agent.";
  } else {
    throw new Error(`No smoke fixture for role: ${spec.name}`);
  }
  const marker = `ROLE_PROBE_OK:${spec.name}`;
  task += ` Return ${marker} in the final response.`;
  return { cwd, task, marker, before: await hashTree(cwd) };
}

async function locateProbeRollouts(options) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const found = await findProbeRollouts(options);
    if (found.parent && found.child) return found;
    await sleep(250);
  }
  return findProbeRollouts(options);
}

function treeDiff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

async function runRoleProbe(spec) {
  const fixture = await createProbeFixture(spec);
  const probeHome = await mkdtemp(
    join(tmpdir(), `sol-ultra-gearbox-v2-home-${spec.name}-`),
  );
  const authLink = join(probeHome, "auth.json");
  await symlink(join(CODEX_HOME, "auth.json"), authLink);
  const startedAtMs = Date.now();
  const parentPrompt = [
    "This is an explicitly authorized typed-role verification.",
    `Call spawn_agent exactly once with agent_type=\"${spec.name}\", task_name=\"gearbox_${spec.name}\", fork_turns=\"none\", and the self-contained message below.`,
    "Do not pass model, reasoning_effort, model_reasoning_effort, or service_tier.",
    "Wait for the child, close it, and return the child result. Do not spawn any other agent.",
    `Child message: ${fixture.task}`,
  ].join("\n");
  const args = [
    "--strict-config",
    "-c",
    "features.multi_agent_v2.enabled=true",
    "-c",
    "features.multi_agent_v2.max_concurrent_threads_per_session=2",
    "-c",
    "features.multi_agent_v2.hide_spawn_agent_metadata=false",
    "-c",
    'features.multi_agent_v2.tool_namespace="agents"',
    "-c",
    "agents.max_depth=1",
    "-c",
    `agents.${spec.name}.description=${JSON.stringify(spec.description)}`,
    "-c",
    `agents.${spec.name}.config_file=${JSON.stringify(rolePath(spec))}`,
    "-c",
    'model="gpt-5.6-sol"',
    "-c",
    'model_reasoning_effort="max"',
    "-c",
    'plugins."superpowers@openai-curated".enabled=false',
    "-s",
    spec.sandbox,
    "-a",
    "never",
    "-C",
    fixture.cwd,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    parentPrompt,
  ];
  let execution;
  let rollouts;
  try {
    execution = await runCommand(CODEX_BIN, args, {
      cwd: fixture.cwd,
      timeoutMs: 900_000,
      env: { CODEX_HOME: probeHome },
    });
    rollouts = await locateProbeRollouts({
      sessionRoot: join(probeHome, "sessions"),
      cwd: fixture.cwd,
      sinceMs: startedAtMs,
    });
  } finally {
    await unlink(authLink).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const verification = verifyProbe({
    spec,
    parent: rollouts.parent,
    child: rollouts.child,
    marker: fixture.marker,
  });
  const after = await hashTree(fixture.cwd);
  const changedFiles = treeDiff(fixture.before, after);
  let filesystemPass;
  if (spec.name === "terra_worker") {
    const content = await readFile(join(fixture.cwd, "worker-target.txt"), "utf8");
    filesystemPass =
      changedFiles.length === 1 &&
      changedFiles[0] === "worker-target.txt" &&
      content === "AFTER\n";
  } else {
    filesystemPass = changedFiles.length === 0;
  }
  const runtimeChecks = {
    commandExitedZero: execution.code === 0,
    commandDidNotTimeout: !execution.timedOut,
    noReservedSchemaMismatch: !/reserved .*schema mismatch|HTTP 400/i.test(
      `${execution.stdout}\n${execution.stderr}`,
    ),
    filesystemScope: filesystemPass,
  };
  const errorSummary =
    execution.code === 0 ? "" : safeErrorSummary(execution.stderr);
  if (errorSummary) {
    process.stderr.write(`SMOKE_COMMAND_ERROR ${spec.name}\n${errorSummary}\n`);
  }
  const result = {
    ...verification,
    pass:
      verification.pass && Object.values(runtimeChecks).every(Boolean),
    runtimeChecks,
    fixture: fixture.cwd,
    changedFiles,
    command: {
      exitCode: execution.code,
      timedOut: execution.timedOut,
      schemaMismatch:
        /reserved .*schema mismatch|HTTP 400/i.test(
          `${execution.stdout}\n${execution.stderr}`,
        ),
      errorSummary,
    },
  };
  let cleanup;
  try {
    cleanup = {
      pass: true,
      ...(await cleanupProbeArtifacts([probeHome, fixture.cwd])),
    };
  } catch (error) {
    cleanup = { pass: false, errorSummary: safeErrorSummary(error.message) };
  }
  result.cleanup = cleanup;
  result.runtimeChecks.temporaryArtifactsCleaned = cleanup.pass;
  result.pass = result.pass && cleanup.pass;
  return result;
}

function smokeMarkdown(report) {
  const rows = report.roles
    .map((item) => {
      const parentTokens = item.actual?.parentTokenUsage?.total_tokens ?? "n/a";
      const childTokens = item.actual?.tokenUsage?.total_tokens ?? "n/a";
      return `| ${item.role} | ${item.pass ? "PASS" : "FAIL"} | ${item.actual?.model ?? "n/a"} | ${item.actual?.effort ?? "n/a"} | ${item.actual?.sandbox ?? "n/a"} | ${parentTokens} | ${childTokens} |`;
    })
    .join("\n");
  return `# Gearbox V2 Role Smoke\n\n- Generated: ${report.generatedAt}\n- Status: ${report.pass ? "PASS" : "FAIL"}\n- Global config unchanged: ${report.globalConfigUnchanged ? "yes" : "no"}\n- Policy: no retries; stop on first failure\n\n| Role | Status | Actual model | Effort | Sandbox | Parent tokens | Child tokens |\n|---|---|---|---|---|---:|---:|\n${rows}\n`;
}

async function runSmokeAll({ writeReport = true } = {}) {
  const globalConfigPath = join(CODEX_HOME, "config.toml");
  const globalConfigBefore = await readOptional(globalConfigPath);
  const roles = [];
  for (const spec of ROLE_SPECS.filter((role) => role.smoke)) {
    process.stdout.write(`SMOKE_START ${spec.name}\n`);
    const result = await runRoleProbe(spec);
    roles.push(result);
    process.stdout.write(`SMOKE_${result.pass ? "PASS" : "FAIL"} ${spec.name}\n`);
    if (!result.pass) break;
  }
  const globalConfigAfter = await readOptional(globalConfigPath);
  const globalConfigUnchanged = globalConfigAfter === globalConfigBefore;
  if (!globalConfigUnchanged) {
    process.stdout.write("SMOKE_FAIL global_config_changed\n");
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pass:
      roles.length === ROLE_SPECS.filter((role) => role.smoke).length &&
      roles.every((item) => item.pass) &&
      globalConfigUnchanged,
    expectedRoleCount: ROLE_SPECS.filter((role) => role.smoke).length,
    globalConfigUnchanged,
    globalConfigBeforeSha256:
      globalConfigBefore === null ? null : sha256(globalConfigBefore),
    globalConfigAfterSha256:
      globalConfigAfter === null ? null : sha256(globalConfigAfter),
    roles,
  };
  if (writeReport) {
    const directory = join(REPO_ROOT, "reports", `${timestamp()}-smoke`);
    await mkdir(directory, { recursive: true });
    await writeJson(join(directory, "smoke.json"), report);
    await atomicWrite(join(directory, "smoke.md"), smokeMarkdown(report));
    report.reportDirectory = directory;
  }
  return report;
}

async function postInstallRootSmoke() {
  const marker = "GLOBAL_V2_ROOT_OK";
  const result = await runCommand(
    CODEX_BIN,
    [
      "--strict-config",
      "-s",
      "read-only",
      "-a",
      "never",
      "-C",
      REPO_ROOT,
      "exec",
      "--json",
      "--skip-git-repo-check",
      `Do not call any tool or spawn any agent. Reply exactly ${marker}.`,
    ],
    { timeoutMs: 600_000 },
  );
  return {
    pass:
      result.code === 0 &&
      !result.timedOut &&
      result.stdout.includes(marker) &&
      !/reserved .*schema mismatch|HTTP 400/i.test(
        `${result.stdout}\n${result.stderr}`,
      ),
    exitCode: result.code,
    timedOut: result.timedOut,
    markerReturned: result.stdout.includes(marker),
    schemaMismatch: /reserved .*schema mismatch|HTTP 400/i.test(
      `${result.stdout}\n${result.stderr}`,
    ),
  };
}

async function rollbackFromManifest(manifestPath, { force = false, reason = null } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.status === "rolled_back" || manifest.status === "failed_rolled_back") {
    return manifest;
  }
  const configPath = manifest.config.path;
  const agentsPath = manifest.agents.path;
  const currentConfig = await readFile(configPath, "utf8");
  const currentAgents = await readFile(agentsPath, "utf8");
  if (!force && manifest.config.afterSha256 && sha256(currentConfig) !== manifest.config.afterSha256) {
    throw new Error("config.toml changed after installation; refusing rollback without --force");
  }
  if (!force && manifest.agents.afterSha256 && sha256(currentAgents) !== manifest.agents.afterSha256) {
    throw new Error("AGENTS.md changed after installation; refusing rollback without --force");
  }

  await atomicWrite(
    configPath,
    rollbackConfig(currentConfig),
    manifest.config.mode ?? 0o600,
  );
  const actions = [];
  actions.push(
    await restoreBackup(manifest.agents.backup, manifest.timestamp),
  );
  for (const entry of manifest.files) {
    actions.push(await restoreBackup(entry.backup, manifest.timestamp));
  }
  manifest.status = reason ? "failed_rolled_back" : "rolled_back";
  manifest.rollback = {
    at: new Date().toISOString(),
    reason,
    actions,
  };
  await writeJson(manifestPath, manifest);
  return manifest;
}

async function installAfterSmoke(smoke) {
  const runTimestamp = timestamp();
  const reportDirectory = join(REPO_ROOT, "reports", `${runTimestamp}-apply`);
  const backupDirectory = join(
    CODEX_HOME,
    "backups",
    "sol-ultra-gearbox-v2",
    runTimestamp,
  );
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });

  const configPath = join(CODEX_HOME, "config.toml");
  const agentsPath = join(CODEX_HOME, "AGENTS.md");
  const launcherPath = join(CODEX_HOME, "bin", "codex-typed-agent");
  const configSource = await readFile(configPath, "utf8");
  const agentsSource = await readFile(agentsPath, "utf8");
  const configTarget = renderConfig(configSource, CODEX_HOME, { promoteV2: true });
  const agentsTarget = renderAgentsMd(agentsSource);
  const configMode = (await stat(configPath)).mode & 0o777;
  const agentsMode = (await stat(agentsPath)).mode & 0o777;

  const agentsBackup = await backupFile(agentsPath, backupDirectory);
  const fileEntries = [];
  for (const spec of ROLE_SPECS) {
    const target = installedRolePath(spec);
    const backup = await backupFile(target, backupDirectory);
    const source = await readFile(rolePath(spec), "utf8");
    fileEntries.push({
      kind: "role",
      role: spec.name,
      sourcePath: rolePath(spec),
      targetPath: target,
      afterSha256: sha256(source),
      backup,
    });
  }
  const launcherBackup = await backupFile(launcherPath, backupDirectory);
  const launcherSource = await readFile(join(REPO_ROOT, "scripts", "codex-typed-agent"), "utf8");
  fileEntries.push({
    kind: "launcher",
    sourcePath: join(REPO_ROOT, "scripts", "codex-typed-agent"),
    targetPath: launcherPath,
    afterSha256: sha256(launcherSource),
    backup: launcherBackup,
  });

  const manifestPath = join(reportDirectory, "install-manifest.json");
  const manifest = {
    schemaVersion: 1,
    timestamp: runTimestamp,
    generatedAt: new Date().toISOString(),
    status: "applying",
    smokeReportDirectory: smoke.reportDirectory ?? null,
    config: {
      path: configPath,
      beforeSha256: sha256(configSource),
      afterSha256: sha256(configTarget),
      mode: configMode,
      managedMarkers: [
        CONFIG_LEGACY_THREADS_MARKER,
        CONFIG_ROLES_MARKER,
        CONFIG_V2_MARKER,
      ],
    },
    agents: {
      path: agentsPath,
      beforeSha256: sha256(agentsSource),
      afterSha256: sha256(agentsTarget),
      mode: agentsMode,
      managedMarker: AGENTS_MARKER,
      backup: agentsBackup,
    },
    files: fileEntries,
  };
  await writeJson(manifestPath, manifest);

  try {
    for (const entry of fileEntries) {
      const source = await readFile(entry.sourcePath, "utf8");
      await atomicWrite(
        entry.targetPath,
        source,
        entry.kind === "launcher" ? 0o755 : 0o644,
      );
    }
    await atomicWrite(agentsPath, agentsTarget, agentsMode);
    await atomicWrite(configPath, configTarget, configMode);

    const strict = await runCommand(CODEX_BIN, ["--strict-config", "--version"]);
    const doctor = await runCommand(CODEX_BIN, ["doctor", "--json"], {
      timeoutMs: 120_000,
    });
    const doctorJson = parseJsonObject(doctor.stdout);
    const staticChecks = {
      strictConfig: strict.code === 0,
      configLoad: doctorJson?.checks?.["config.load"]?.status === "ok",
      mcpConfig: doctorJson?.checks?.["mcp.config"]?.status === "ok",
      installation: doctorJson?.checks?.installation?.status === "ok",
    };
    if (!Object.values(staticChecks).every(Boolean)) {
      throw new Error("Post-install static checks failed");
    }

    const rootSmoke = await postInstallRootSmoke();
    if (!rootSmoke.pass) throw new Error("Post-install fresh-root smoke failed");

    manifest.status = "applied";
    manifest.completedAt = new Date().toISOString();
    manifest.staticChecks = staticChecks;
    manifest.postInstallRootSmoke = rootSmoke;
    await writeJson(manifestPath, manifest);
    await atomicWrite(
      join(reportDirectory, "result.md"),
      `# Gearbox V2 Apply Result\n\n- Status: PASS\n- Manifest: ${manifestPath}\n- Five-role smoke: PASS\n- Post-install fresh-root smoke: PASS\n- Current tasks retain their original tool schema; restart Codex and open a new task.\n`,
    );
    return { manifestPath, manifest };
  } catch (error) {
    await rollbackFromManifest(manifestPath, {
      force: true,
      reason: error.message,
    });
    throw error;
  }
}

async function cleanupSmokeProjects(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.status !== "applied") {
    throw new Error("cleanup requires an applied manifest");
  }
  const current = await readFile(manifest.config.path, "utf8");
  if (sha256(current) !== manifest.config.afterSha256) {
    throw new Error("config.toml drifted after apply; refusing cleanup");
  }
  const cleaned = removeOwnedSmokeProjectEntries(current);
  if (cleaned.paths.length === 0) {
    throw new Error("No Gearbox smoke project entries found");
  }
  const beforeSha256 = sha256(current);
  const afterSha256 = sha256(cleaned.source);
  await atomicWrite(
    manifest.config.path,
    cleaned.source,
    manifest.config.mode ?? 0o600,
  );
  manifest.config.appliedSha256 = beforeSha256;
  manifest.config.afterSha256 = afterSha256;
  manifest.config.managedMarkers = [
    CONFIG_LEGACY_THREADS_MARKER,
    CONFIG_ROLES_MARKER,
    CONFIG_V2_MARKER,
  ];
  manifest.postApplyCleanup = {
    at: new Date().toISOString(),
    removedSmokeProjectEntries: cleaned.paths,
    beforeSha256,
    afterSha256,
  };
  await writeJson(manifestPath, manifest);
  const resultPath = join(dirname(manifestPath), "result.md");
  const resultSource = await readOptional(resultPath);
  if (
    resultSource !== null &&
    !resultSource.includes("Smoke temp project entries cleaned")
  ) {
    await atomicWrite(
      resultPath,
      `${resultSource.trimEnd()}\n- Smoke temp project entries cleaned: ${cleaned.paths.length}; rollback hash updated.\n`,
    );
  }
  return manifest.postApplyCleanup;
}

async function dryRunApply() {
  const doctor = await runDoctor();
  const configPath = join(CODEX_HOME, "config.toml");
  const agentsPath = join(CODEX_HOME, "AGENTS.md");
  const configSource = await readFile(configPath, "utf8");
  const agentsSource = await readFile(agentsPath, "utf8");
  const configTarget = renderConfig(configSource, CODEX_HOME, { promoteV2: true });
  const agentsTarget = renderAgentsMd(agentsSource);
  return {
    pass: doctor.pass,
    doctor,
    changes: {
      config: {
        beforeSha256: sha256(configSource),
        afterSha256: sha256(configTarget),
        changed: configSource !== configTarget,
      },
      agents: {
        beforeSha256: sha256(agentsSource),
        afterSha256: sha256(agentsTarget),
        changed: agentsSource !== agentsTarget,
      },
      installedRoleCount: ROLE_SPECS.length,
      secretsCopiedToReport: false,
    },
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function usage() {
  process.stderr.write(`Usage:
  node scripts/gearbox.mjs doctor [--json]
  node scripts/gearbox.mjs smoke --all
  node scripts/gearbox.mjs apply --promote-v2 [--dry-run]
  node scripts/gearbox.mjs cleanup-smoke-projects --manifest <path>
  node scripts/gearbox.mjs rollback --manifest <path> [--force]
`);
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exitCode = command ? 0 : 2;
    return;
  }

  if (command === "doctor") {
    const report = await runDoctor();
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(redactSensitive(report), null, 2)}\n`);
    } else {
      process.stdout.write(`GEARBOX_DOCTOR_${report.pass ? "PASS" : "FAIL"}\n`);
      for (const [name, pass] of Object.entries(report.checks)) {
        process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}\n`);
      }
    }
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "smoke") {
    if (!args.includes("--all")) throw new Error("smoke requires --all");
    const report = await runSmokeAll();
    process.stdout.write(`GEARBOX_SMOKE_${report.pass ? "PASS" : "FAIL"}\n`);
    process.stdout.write(`REPORT ${report.reportDirectory}\n`);
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "apply") {
    if (!args.includes("--promote-v2")) {
      throw new Error("apply requires --promote-v2");
    }
    if (args.includes("--dry-run")) {
      const report = await dryRunApply();
      process.stdout.write(`${JSON.stringify(redactSensitive(report), null, 2)}\n`);
      if (!report.pass) process.exitCode = 1;
      return;
    }
    const doctor = await runDoctor();
    if (!doctor.pass) throw new Error("Preflight doctor failed");
    const smoke = await runSmokeAll();
    if (!smoke.pass) {
      throw new Error(
        `Five-role smoke failed; global config was not changed. Report: ${smoke.reportDirectory}`,
      );
    }
    const result = await installAfterSmoke(smoke);
    process.stdout.write("GEARBOX_APPLY_PASS\n");
    process.stdout.write(`MANIFEST ${result.manifestPath}\n`);
    return;
  }

  if (command === "cleanup-smoke-projects") {
    const manifest = optionValue(args, "--manifest");
    if (!manifest) throw new Error("cleanup-smoke-projects requires --manifest");
    const result = await cleanupSmokeProjects(resolve(manifest));
    process.stdout.write("GEARBOX_CLEANUP_PASS\n");
    process.stdout.write(`${JSON.stringify(redactSensitive(result), null, 2)}\n`);
    return;
  }

  if (command === "rollback") {
    const manifest = optionValue(args, "--manifest");
    if (!manifest) throw new Error("rollback requires --manifest <path>");
    const result = await rollbackFromManifest(resolve(manifest), {
      force: args.includes("--force"),
    });
    process.stdout.write(`GEARBOX_ROLLBACK_${result.status.toUpperCase()}\n`);
    return;
  }

  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`GEARBOX_ERROR ${error.message}\n`);
  process.exitCode = 1;
});
