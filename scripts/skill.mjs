#!/usr/bin/env node

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SKILL_NAME,
  inspectSkillInstall,
  installSkill,
  uninstallSkill,
} from "../lib/skill-install.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(REPO_ROOT, "skills", SKILL_NAME);

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function usage() {
  process.stderr.write(`Usage:
  node scripts/skill.mjs status [--target <path>]
  node scripts/skill.mjs install [--target <path>] [--apply]
  node scripts/skill.mjs uninstall [--target <path>] [--apply]
`);
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exitCode = command ? 0 : 2;
    return;
  }
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const target = resolve(
    optionValue(args, "--target") ?? join(codexHome, "skills", SKILL_NAME),
  );
  let result;
  if (command === "status") {
    result = await inspectSkillInstall({ source: SOURCE, target });
  } else if (command === "install") {
    result = await installSkill({
      source: SOURCE,
      target,
      apply: args.includes("--apply"),
    });
  } else if (command === "uninstall") {
    result = await uninstallSkill({
      target,
      apply: args.includes("--apply"),
    });
  } else {
    usage();
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`GEARBOX_SKILL_ERROR ${error.message}\n`);
  process.exitCode = 1;
});
