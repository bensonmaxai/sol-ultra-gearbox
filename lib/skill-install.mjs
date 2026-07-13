import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

export const SKILL_NAME = "sol-ultra-gearbox";
export const INSTALL_MANIFEST = ".sol-ultra-gearbox-install.json";

const REQUIRED_FILES = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/risk-gates.md",
  "references/routing-matrix.md",
  "references/subagent-skill-compatibility.md",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "");
}

function archiveRoot(targetPath) {
  const targetParent = dirname(targetPath);
  if (basename(targetParent) === "skills") {
    return join(dirname(targetParent), "backups", "skills", SKILL_NAME);
  }
  return join(targetParent, `.${SKILL_NAME}-archives`);
}

function archivePath(targetPath, kind, suffix = timestamp()) {
  return join(archiveRoot(targetPath), `${kind}.${suffix}`);
}

function archiveDirectoryChain(targetPath) {
  const targetParent = dirname(targetPath);
  if (basename(targetParent) === "skills") {
    const codexHome = dirname(targetParent);
    const backups = join(codexHome, "backups");
    const skills = join(backups, "skills");
    return [backups, skills, join(skills, SKILL_NAME)];
  }
  return [archiveRoot(targetPath)];
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureArchiveRoot(targetPath) {
  for (const path of archiveDirectoryChain(targetPath)) {
    let state = await pathState(path);
    if (state === null) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      state = await pathState(path);
    }
    if (!state?.isDirectory() || state.isSymbolicLink()) {
      throw new Error(`Skill archive path must be a real directory: ${path}`);
    }
  }
  return archiveRoot(targetPath);
}

function assertSafeRelativePath(path) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    throw new Error(`Unsafe skill path: ${path}`);
  }
}

async function listFiles(root) {
  const output = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill trees may not contain symlinks: ${path}`);
      }
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const name = relative(root, path).split("\\").join("/");
        if (name !== INSTALL_MANIFEST) output.push(name);
      }
    }
  }
  await walk(root);
  return output.sort();
}

async function hashFiles(root, files) {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        assertSafeRelativePath(file);
        return [file, sha256(await readFile(join(root, file)))];
      }),
    ),
  );
}

async function sourceSnapshot(source) {
  const sourceState = await pathState(source);
  if (!sourceState?.isDirectory() || sourceState.isSymbolicLink()) {
    throw new Error(`Skill source must be a real directory: ${source}`);
  }
  const files = await listFiles(source);
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) {
      throw new Error(`Skill source is missing ${required}`);
    }
  }
  return { files, hashes: await hashFiles(source, files) };
}

async function installedSnapshot(target) {
  const targetState = await pathState(target);
  if (targetState === null) return { state: "absent" };
  if (!targetState.isDirectory() || targetState.isSymbolicLink()) {
    return { state: "unmanaged", reason: "target is not a real directory" };
  }
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(target, INSTALL_MANIFEST), "utf8"),
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { state: "unmanaged", reason: "missing or invalid manifest" };
    }
    throw error;
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.skillName !== SKILL_NAME ||
    !manifest.files ||
    typeof manifest.files !== "object"
  ) {
    return { state: "unmanaged", reason: "unexpected manifest schema" };
  }
  const manifestFiles = Object.keys(manifest.files).sort();
  for (const file of manifestFiles) {
    try {
      assertSafeRelativePath(file);
    } catch (error) {
      return { state: "unmanaged", reason: error.message };
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.files[file])) {
      return { state: "unmanaged", reason: `invalid hash for ${file}` };
    }
  }
  const currentFiles = await listFiles(target);
  if (JSON.stringify(currentFiles) !== JSON.stringify(manifestFiles)) {
    return { state: "drifted", reason: "installed file set changed", manifest };
  }
  const currentHashes = await hashFiles(target, currentFiles);
  const changed = currentFiles.filter(
    (file) => currentHashes[file] !== manifest.files[file],
  );
  if (changed.length > 0) {
    return {
      state: "drifted",
      reason: `installed files changed: ${changed.join(", ")}`,
      manifest,
    };
  }
  return { state: "managed", manifest, files: currentFiles, hashes: currentHashes };
}

async function legacyArchiveSnapshot(targetPath) {
  const parent = dirname(targetPath);
  const targetName = basename(targetPath);
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { managed: [], issues: [] };
    throw error;
  }

  const managed = [];
  const issues = [];
  for (const entry of entries) {
    const kind = ["backup", "disabled"].find((candidate) =>
      entry.name.startsWith(`${targetName}.${candidate}.`),
    );
    if (!kind) continue;
    const suffix = entry.name.slice(`${targetName}.${kind}.`.length);
    if (!suffix) continue;
    const path = join(parent, entry.name);
    const state = await installedSnapshot(path);
    const archive = { path, kind, suffix };
    if (state.state === "managed") {
      managed.push(archive);
    } else {
      issues.push({
        ...archive,
        state: state.state,
        reason: state.reason ?? "legacy archive is not managed",
      });
    }
  }
  return {
    managed: managed.sort((left, right) => left.path.localeCompare(right.path)),
    issues: issues.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function migrateLegacyArchives(targetPath, archives) {
  if (archives.length === 0) return [];
  const root = await ensureArchiveRoot(targetPath);
  const moves = archives.map((archive) => ({
    source: archive.path,
    destination: archivePath(targetPath, archive.kind, archive.suffix),
  }));
  for (const move of moves) {
    if (await pathState(move.destination)) {
      throw new Error(`Refusing to overwrite skill archive: ${move.destination}`);
    }
  }

  const completed = [];
  try {
    for (const move of moves) {
      await rename(move.source, move.destination);
      completed.push(move);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const move of completed.reverse()) {
      try {
        await rename(move.destination, move.source);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Legacy skill archive migration failed and rollback was incomplete: ${rollbackErrors.join("; ")}`,
      );
    }
    throw error;
  }
  return moves;
}

export async function inspectSkillInstall({ source, target }) {
  const targetPath = resolve(target);
  const canonical = await sourceSnapshot(resolve(source));
  const installed = await installedSnapshot(targetPath);
  const legacy = await legacyArchiveSnapshot(targetPath);
  const upToDate =
    installed.state === "managed" &&
    JSON.stringify(installed.hashes) === JSON.stringify(canonical.hashes);
  return {
    target: targetPath,
    state: installed.state,
    reason: installed.reason ?? null,
    upToDate,
    sourceFiles: canonical.files,
    sourceHashes: canonical.hashes,
    legacyArchives: legacy.managed,
    legacyArchiveIssues: legacy.issues,
  };
}

function assertSafeInstalledState(state) {
  if (state.state === "unmanaged" || state.state === "drifted") {
    throw new Error(`Refusing to modify ${state.state} skill target: ${state.reason}`);
  }
  if ((state.legacyArchiveIssues ?? []).length > 0) {
    const issue = state.legacyArchiveIssues[0];
    throw new Error(
      `Refusing to migrate ${issue.state} legacy skill archive ${issue.path}: ${issue.reason}`,
    );
  }
}

export async function installSkill({ source, target, apply = false }) {
  const sourcePath = resolve(source);
  const targetPath = resolve(target);
  const state = await inspectSkillInstall({ source: sourcePath, target: targetPath });
  assertSafeInstalledState(state);
  const legacyArchiveCount = state.legacyArchives.length;
  if (state.upToDate && legacyArchiveCount === 0) {
    return { pass: true, action: "up_to_date", applied: false, target: targetPath };
  }
  if (state.upToDate && !apply) {
    return {
      pass: true,
      action: "would_migrate_archives",
      applied: false,
      target: targetPath,
      legacyArchiveCount,
    };
  }
  if (state.upToDate) {
    const migratedLegacyArchives = await migrateLegacyArchives(
      targetPath,
      state.legacyArchives,
    );
    return {
      pass: true,
      action: "archives_migrated",
      applied: true,
      target: targetPath,
      migratedLegacyArchives,
    };
  }
  if (!apply) {
    return {
      pass: true,
      action: state.state === "absent" ? "would_install" : "would_update",
      applied: false,
      target: targetPath,
      fileCount: state.sourceFiles.length,
      legacyArchiveCount,
    };
  }

  const parent = dirname(targetPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(parent, `.${SKILL_NAME}-stage-`));
  let backupPath = null;
  try {
    for (const file of state.sourceFiles) {
      const destination = join(stage, file);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(join(sourcePath, file), destination);
    }
    const manifest = {
      schemaVersion: 1,
      skillName: SKILL_NAME,
      installedAt: new Date().toISOString(),
      files: state.sourceHashes,
    };
    await writeFile(
      join(stage, INSTALL_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const migratedLegacyArchives = await migrateLegacyArchives(
      targetPath,
      state.legacyArchives,
    );
    if (state.state === "managed") {
      await ensureArchiveRoot(targetPath);
      backupPath = archivePath(targetPath, "backup");
      if (await pathState(backupPath)) {
        throw new Error(`Refusing to overwrite skill archive: ${backupPath}`);
      }
      await rename(targetPath, backupPath);
    }
    try {
      await rename(stage, targetPath);
    } catch (error) {
      if (backupPath) await rename(backupPath, targetPath);
      throw error;
    }
    return {
      pass: true,
      action: backupPath ? "updated" : "installed",
      applied: true,
      target: targetPath,
      backupPath,
      migratedLegacyArchives,
      fileCount: state.sourceFiles.length,
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function uninstallSkill({ target, apply = false }) {
  const targetPath = resolve(target);
  const installed = await installedSnapshot(targetPath);
  const legacy = await legacyArchiveSnapshot(targetPath);
  const state = {
    ...installed,
    legacyArchives: legacy.managed,
    legacyArchiveIssues: legacy.issues,
  };
  assertSafeInstalledState(state);
  if (state.state === "absent" && state.legacyArchives.length === 0) {
    return { pass: true, action: "already_absent", applied: false, target: targetPath };
  }
  if (!apply) {
    return {
      pass: true,
      action:
        state.state === "absent" ? "would_migrate_archives" : "would_disable",
      applied: false,
      target: targetPath,
      legacyArchiveCount: state.legacyArchives.length,
    };
  }
  const migratedLegacyArchives = await migrateLegacyArchives(
    targetPath,
    state.legacyArchives,
  );
  if (state.state === "absent") {
    return {
      pass: true,
      action: "archives_migrated",
      applied: true,
      target: targetPath,
      migratedLegacyArchives,
    };
  }
  await ensureArchiveRoot(targetPath);
  const disabledPath = archivePath(targetPath, "disabled");
  if (await pathState(disabledPath)) {
    throw new Error(`Refusing to overwrite skill archive: ${disabledPath}`);
  }
  await rename(targetPath, disabledPath);
  return {
    pass: true,
    action: "disabled",
    applied: true,
    target: targetPath,
    disabledPath,
    migratedLegacyArchives,
  };
}
