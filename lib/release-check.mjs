import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createRepositorySourceManifest,
  validateReleaseEvidence,
} from "./release-evidence.mjs";

const PRIVATE_HOME = new RegExp(
  "/" + "Users/(?!example(?:/|$)|test(?:/|$)|username(?:/|$))[^\\s\\\"'`]+",
  "g",
);
const TOKEN_PATTERNS = [
  { name: "GitHub token", regex: new RegExp("gh" + "[opusr]_[A-Za-z0-9_]{20,}", "g") },
  { name: "OpenAI-style key", regex: new RegExp("sk" + "-[A-Za-z0-9_-]{20,}", "g") },
  { name: "AWS access key", regex: new RegExp("AK" + "IA[0-9A-Z]{16}", "g") },
  {
    name: "private key",
    regex: new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "g"),
  },
];

export function scanText(path, source) {
  const issues = [];
  if (PRIVATE_HOME.test(source)) issues.push(`${path}: private macOS home path`);
  PRIVATE_HOME.lastIndex = 0;
  for (const pattern of TOKEN_PATTERNS) {
    if (pattern.regex.test(source)) issues.push(`${path}: ${pattern.name}`);
    pattern.regex.lastIndex = 0;
  }
  if (/\[TODO(?:\]|:)/i.test(source)) issues.push(`${path}: unresolved TODO`);
  return issues;
}

export function releaseCandidateFiles(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  ).toString("utf8");
  return output.split("\0").filter(Boolean).sort();
}

export const REQUIRED_RELEASE_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs/REAL_WORK_EVIDENCE.md",
  "docs/RELEASE_EVIDENCE.md",
  "docs/release-evidence.json",
  "docs/workflow-contract-evidence.json",
  "skills/sol-ultra-gearbox/SKILL.md",
  "skills/sol-ultra-gearbox/agents/openai.yaml",
  "skills/sol-ultra-gearbox/references/risk-gates.md",
  "skills/sol-ultra-gearbox/references/routing-matrix.md",
  "skills/sol-ultra-gearbox/references/subagent-skill-compatibility.md",
  "skills/sol-ultra-gearbox/references/quality-first-dispatch.md",
  "skills/sol-ultra-gearbox/references/verified-workflows.md",
]);

export async function scanRepository(root) {
  const files = releaseCandidateFiles(root);
  const issues = [];
  for (const path of REQUIRED_RELEASE_FILES) {
    if (!files.includes(path)) issues.push(`missing required release file: ${path}`);
  }
  for (const path of files) {
    if (path.startsWith("reports/")) {
      issues.push(`${path}: raw reports must remain untracked`);
      continue;
    }
    const name = basename(path);
    if (
      name === "auth.json" ||
      name === "secrets.json" ||
      (name.startsWith(".env") && name !== ".env.example")
    ) {
      issues.push(`${path}: sensitive filename`);
      continue;
    }
    const metadata = await lstat(join(root, path));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      issues.push(`${path}: release files must be regular non-symlink files`);
      continue;
    }
    if (metadata.size > 5 * 1024 * 1024) {
      issues.push(`${path}: file exceeds 5 MiB release limit`);
      continue;
    }
    const content = await readFile(join(root, path));
    if (content.includes(0)) continue;
    issues.push(...scanText(path, content.toString("utf8")));
  }
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (packageJson.private !== true) {
    issues.push("package.json: private must remain true to prevent npm publication");
  }
  if (packageJson.license !== "MIT") issues.push("package.json: expected MIT license");

  const skillSource = await readFile(
    join(root, "skills", "sol-ultra-gearbox", "SKILL.md"),
    "utf8",
  );
  const frontmatter = skillSource.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) {
    issues.push("SKILL.md: missing YAML frontmatter");
  } else {
    const keys = frontmatter[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-z_]+):/)?.[1])
      .filter(Boolean)
      .sort();
    if (JSON.stringify(keys) !== JSON.stringify(["description", "name"])) {
      issues.push("SKILL.md: frontmatter must contain only name and description");
    }
  }
  const openaiYaml = await readFile(
    join(root, "skills", "sol-ultra-gearbox", "agents", "openai.yaml"),
    "utf8",
  );
  if (!openaiYaml.includes("$sol-ultra-gearbox")) {
    issues.push("openai.yaml: default prompt must mention $sol-ultra-gearbox");
  }

  try {
    const evidence = JSON.parse(
      await readFile(join(root, "docs", "release-evidence.json"), "utf8"),
    );
    const markdown = await readFile(
      join(root, "docs", "RELEASE_EVIDENCE.md"),
      "utf8",
    );
    const currentSource = await createRepositorySourceManifest(root, files);
    const validation = validateReleaseEvidence({
      evidence,
      markdown,
      currentSource,
    });
    for (const [name, pass] of Object.entries(validation.checks)) {
      if (!pass) issues.push(`release evidence failed: ${name}`);
    }
  } catch (error) {
    issues.push(`release evidence unavailable: ${error.message}`);
  }
  return { pass: issues.length === 0, files, issues };
}
