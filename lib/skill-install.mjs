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
import { dirname, join, relative, resolve } from "node:path";

export const SKILL_NAME = "sol-ultra-gearbox";
export const INSTALL_MANIFEST = ".sol-ultra-gearbox-install.json";

const REQUIRED_FILES = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/risk-gates.md",
  "references/routing-matrix.md",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "");
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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

export async function inspectSkillInstall({ source, target }) {
  const canonical = await sourceSnapshot(resolve(source));
  const installed = await installedSnapshot(resolve(target));
  const upToDate =
    installed.state === "managed" &&
    JSON.stringify(installed.hashes) === JSON.stringify(canonical.hashes);
  return {
    target: resolve(target),
    state: installed.state,
    reason: installed.reason ?? null,
    upToDate,
    sourceFiles: canonical.files,
    sourceHashes: canonical.hashes,
  };
}

function assertSafeInstalledState(state) {
  if (state.state === "unmanaged" || state.state === "drifted") {
    throw new Error(`Refusing to modify ${state.state} skill target: ${state.reason}`);
  }
}

export async function installSkill({ source, target, apply = false }) {
  const sourcePath = resolve(source);
  const targetPath = resolve(target);
  const state = await inspectSkillInstall({ source: sourcePath, target: targetPath });
  assertSafeInstalledState(state);
  if (state.upToDate) {
    return { pass: true, action: "up_to_date", applied: false, target: targetPath };
  }
  if (!apply) {
    return {
      pass: true,
      action: state.state === "absent" ? "would_install" : "would_update",
      applied: false,
      target: targetPath,
      fileCount: state.sourceFiles.length,
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
    if (state.state === "managed") {
      backupPath = `${targetPath}.backup.${timestamp()}`;
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
      fileCount: state.sourceFiles.length,
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function uninstallSkill({ target, apply = false }) {
  const targetPath = resolve(target);
  const state = await installedSnapshot(targetPath);
  if (state.state === "absent") {
    return { pass: true, action: "already_absent", applied: false, target: targetPath };
  }
  assertSafeInstalledState(state);
  if (!apply) {
    return { pass: true, action: "would_disable", applied: false, target: targetPath };
  }
  const disabledPath = `${targetPath}.disabled.${timestamp()}`;
  await rename(targetPath, disabledPath);
  return {
    pass: true,
    action: "disabled",
    applied: true,
    target: targetPath,
    disabledPath,
  };
}
