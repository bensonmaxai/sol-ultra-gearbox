import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), content, "utf8");
  }
  return { root, source, target };
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
  const { source, target } = await fixture(t);
  await installSkill({ source, target, apply: true });
  const reference = join(source, "references", "risk-gates.md");
  await writeFile(reference, "# Updated gates\n", "utf8");
  const preview = await installSkill({ source, target });
  assert.equal(preview.action, "would_update");
  const updated = await installSkill({ source, target, apply: true });
  assert.equal(updated.action, "updated");
  assert.ok(updated.backupPath);
  assert.equal(await readFile(join(target, "references", "risk-gates.md"), "utf8"), "# Updated gates\n");
  assert.equal(await readFile(join(updated.backupPath, "references", "risk-gates.md"), "utf8"), "# Gates\n");
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
  const { source, target } = await fixture(t);
  await installSkill({ source, target, apply: true });
  const preview = await uninstallSkill({ target });
  assert.equal(preview.action, "would_disable");
  const result = await uninstallSkill({ target, apply: true });
  assert.equal(result.action, "disabled");
  assert.match(await readFile(join(result.disabledPath, "SKILL.md"), "utf8"), /sol-ultra-gearbox/);
});
