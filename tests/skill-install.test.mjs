import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  inspectSkillInstall,
  installSkill,
  uninstallSkill,
} from "../lib/skill-install.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gearbox-skill-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "codex", "skills", "sol-ultra-gearbox");
  const files = {
    "SKILL.md": "---\nname: sol-ultra-gearbox\ndescription: test\n---\n",
    "agents/openai.yaml": "interface:\n  display_name: test\n",
    "references/risk-gates.md": "# Gates\n",
    "references/routing-matrix.md": "# Routing\n",
    "references/subagent-skill-compatibility.md": "# Compatibility\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), content, "utf8");
  }
  return { root, source, target };
}

async function createArchiveRootSymlink(root) {
  const parent = join(root, "codex", "backups", "skills");
  const archive = join(parent, "sol-ultra-gearbox");
  const external = join(root, "external-archive-target");
  await mkdir(parent, { recursive: true });
  await mkdir(external, { recursive: true });
  await symlink(external, archive, "dir");
  return { archive, external };
}

test("skill install is preview-only by default and idempotent after apply", async (t) => {
  const { source, target } = await fixture(t);
  const preview = await installSkill({ source, target });
  assert.equal(preview.action, "would_install");
  await assert.rejects(readFile(target), /ENOENT/);

  const installed = await installSkill({ source, target, apply: true });
  assert.equal(installed.action, "installed");
  const status = await inspectSkillInstall({ source, target });
  assert.equal(status.state, "managed");
  assert.equal(status.upToDate, true);
  assert.ok(
    status.sourceFiles.includes("references/subagent-skill-compatibility.md"),
  );
  const repeated = await installSkill({ source, target, apply: true });
  assert.equal(repeated.action, "up_to_date");
});

test("skill install refuses an unmanaged target", async (t) => {
  const { source, target } = await fixture(t);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "SKILL.md"), "unmanaged\n", "utf8");
  await assert.rejects(
    installSkill({ source, target, apply: true }),
    /Refusing to modify unmanaged/,
  );
});

test("skill update preserves the previous managed directory as a backup", async (t) => {
  const { root, source, target } = await fixture(t);
  await installSkill({ source, target, apply: true });
  const reference = join(source, "references", "risk-gates.md");
  await writeFile(reference, "# Updated gates\n", "utf8");
  const preview = await installSkill({ source, target });
  assert.equal(preview.action, "would_update");
  const updated = await installSkill({ source, target, apply: true });
  assert.equal(updated.action, "updated");
  assert.ok(updated.backupPath);
  assert.equal(
    dirname(updated.backupPath),
    join(root, "codex", "backups", "skills", "sol-ultra-gearbox"),
  );
  assert.equal(await readFile(join(target, "references", "risk-gates.md"), "utf8"), "# Updated gates\n");
  assert.equal(await readFile(join(updated.backupPath, "references", "risk-gates.md"), "utf8"), "# Gates\n");
});

test("skill install migrates managed sibling archives out of the skills directory", async (t) => {
  const { root, source, target } = await fixture(t);
  await installSkill({ source, target, apply: true });
  const legacyPath = `${target}.backup.20260713000000000`;
  await cp(target, legacyPath, { recursive: true });

  const preview = await installSkill({ source, target });
  assert.equal(preview.action, "would_migrate_archives");
  assert.equal(preview.legacyArchiveCount, 1);

  const result = await installSkill({ source, target, apply: true });
  assert.equal(result.action, "archives_migrated");
  assert.equal(result.migratedLegacyArchives.length, 1);
  const destination = result.migratedLegacyArchives[0].destination;
  assert.equal(
    dirname(destination),
    join(root, "codex", "backups", "skills", "sol-ultra-gearbox"),
  );
  assert.equal(await readFile(join(destination, "SKILL.md"), "utf8"), "---\nname: sol-ultra-gearbox\ndescription: test\n---\n");
  await assert.rejects(readFile(join(legacyPath, "SKILL.md")), /ENOENT/);

  const status = await inspectSkillInstall({ source, target });
  assert.equal(status.upToDate, true);
  assert.deepEqual(status.legacyArchives, []);
});

test("skill install refuses a drifted legacy sibling archive", async (t) => {
  const { source, target } = await fixture(t);
  await installSkill({ source, target, apply: true });
  const legacyPath = `${target}.disabled.20260713000000000`;
  await cp(target, legacyPath, { recursive: true });
  await writeFile(join(legacyPath, "SKILL.md"), "local archive edit\n", "utf8");

  await assert.rejects(
    installSkill({ source, target }),
    /Refusing to migrate drifted legacy skill archive/,
  );
  assert.equal(await readFile(join(legacyPath, "SKILL.md"), "utf8"), "local archive edit\n");
});

test("skill archive operations fail closed on a symlinked archive root", async (t) => {
  const migration = await fixture(t);
  await installSkill({
    source: migration.source,
    target: migration.target,
    apply: true,
  });
  const legacyPath = `${migration.target}.backup.20260713000000000`;
  await cp(migration.target, legacyPath, { recursive: true });
  const migrationArchive = await createArchiveRootSymlink(migration.root);
  await assert.rejects(
    installSkill({
      source: migration.source,
      target: migration.target,
      apply: true,
    }),
    /Skill archive path must be a real directory/,
  );
  assert.match(await readFile(join(migration.target, "SKILL.md"), "utf8"), /sol-ultra-gearbox/);
  assert.match(await readFile(join(legacyPath, "SKILL.md"), "utf8"), /sol-ultra-gearbox/);
  assert.deepEqual(await readdir(migrationArchive.external), []);

  const update = await fixture(t);
  await installSkill({ source: update.source, target: update.target, apply: true });
  await writeFile(
    join(update.source, "references", "risk-gates.md"),
    "# Updated gates\n",
    "utf8",
  );
  const updateArchive = await createArchiveRootSymlink(update.root);
  await assert.rejects(
    installSkill({ source: update.source, target: update.target, apply: true }),
    /Skill archive path must be a real directory/,
  );
  assert.equal(
    await readFile(join(update.target, "references", "risk-gates.md"), "utf8"),
    "# Gates\n",
  );
  assert.deepEqual(await readdir(updateArchive.external), []);

  const uninstall = await fixture(t);
  await installSkill({
    source: uninstall.source,
    target: uninstall.target,
    apply: true,
  });
  const uninstallArchive = await createArchiveRootSymlink(uninstall.root);
  await assert.rejects(
    uninstallSkill({ target: uninstall.target, apply: true }),
    /Skill archive path must be a real directory/,
  );
  assert.match(await readFile(join(uninstall.target, "SKILL.md"), "utf8"), /sol-ultra-gearbox/);
  assert.deepEqual(await readdir(uninstallArchive.external), []);
});

test("skill update and uninstall refuse locally modified managed files", async (t) => {
  const { source, target } = await fixture(t);
  await installSkill({ source, target, apply: true });
  await writeFile(join(target, "SKILL.md"), "local edit\n", "utf8");
  await assert.rejects(
    installSkill({ source, target, apply: true }),
    /Refusing to modify drifted/,
  );
  await assert.rejects(
    uninstallSkill({ target, apply: true }),
    /Refusing to modify drifted/,
  );
});

test("skill uninstall previews then disables without deleting", async (t) => {
  const { root, source, target } = await fixture(t);
  await installSkill({ source, target, apply: true });
  const preview = await uninstallSkill({ target });
  assert.equal(preview.action, "would_disable");
  const result = await uninstallSkill({ target, apply: true });
  assert.equal(result.action, "disabled");
  assert.equal(
    dirname(result.disabledPath),
    join(root, "codex", "backups", "skills", "sol-ultra-gearbox"),
  );
  assert.match(await readFile(join(result.disabledPath, "SKILL.md"), "utf8"), /sol-ultra-gearbox/);
});
