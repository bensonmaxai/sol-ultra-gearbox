#!/usr/bin/env node
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflowContractEvidence } from "../lib/workflow-contract-evidence.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

function usage() {
  return "Usage: node scripts/workflow-contract-evidence.mjs --output <repository-relative-path> | --check <repository-relative-path>";
}

async function repositoryPath(input) {
  if (typeof input !== "string" || input.length === 0 || isAbsolute(input)) throw new TypeError("workflow evidence path must be repository-relative");
  const path = resolve(REPO_ROOT, input);
  const fromRoot = relative(REPO_ROOT, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) throw new TypeError("workflow evidence path escapes repository");
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new TypeError("workflow evidence path must be a regular file or absent");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  const parentRelative = relative(REPO_ROOT, parent);
  if (parentRelative === ".." || parentRelative.startsWith("../") || isAbsolute(parentRelative)) throw new TypeError("workflow evidence parent escapes repository");
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new TypeError("workflow evidence parent must be a real directory");
  return path;
}

async function atomicWrite(path, source) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, source, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function main(args) {
  if (args.length !== 2 || !["--output", "--check"].includes(args[0])) throw new TypeError(usage());
  const [mode, input] = args;
  const path = await repositoryPath(input);
  const source = `${JSON.stringify(buildWorkflowContractEvidence(), null, 2)}\n`;
  if (mode === "--output") {
    await atomicWrite(path, source);
    process.stdout.write("PASS_CONTRACT\n");
    return;
  }
  const current = await readFile(path, "utf8");
  if (current !== source) throw new TypeError("workflow contract evidence drifted");
  process.stdout.write("PASS_CONTRACT\n");
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
