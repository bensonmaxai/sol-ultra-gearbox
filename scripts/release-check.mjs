#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepository } from "../lib/release-check.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await scanRepository(root);
if (!result.pass) {
  for (const issue of result.issues) process.stderr.write(`RELEASE_FAIL ${issue}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`RELEASE_CHECK_PASS files=${result.files.length}\n`);
}
