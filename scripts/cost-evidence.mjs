#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  addRecord,
  createLedger,
  evaluateLedger,
  validateLedger,
} from "../lib/cost-evidence.mjs";

const DEFAULT_LEDGER_PATH = "reports/cost-evidence.json";

function usage() {
  return [
    "Usage:",
    "  node scripts/cost-evidence.mjs status [ledger-path]",
    "  node scripts/cost-evidence.mjs add <ledger-path> <record-json-path>",
  ].join("\n");
}

async function loadLedger(path, allowMissing) {
  try {
    const source = await readFile(path, "utf8");
    const ledger = JSON.parse(source);
    const validation = validateLedger(ledger);
    if (!validation.valid) throw new TypeError(validation.errors.join("; "));
    return ledger;
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return createLedger();
    throw error;
  }
}

async function writeLedgerAtomically(path, ledger) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "status" && args.length <= 1) {
    const path = resolve(args[0] ?? DEFAULT_LEDGER_PATH);
    const ledger = await loadLedger(path, true);
    process.stdout.write(`${JSON.stringify(evaluateLedger(ledger), null, 2)}\n`);
    return;
  }
  if (command === "add" && args.length === 2) {
    const [ledgerPath, recordPath] = args.map((path) => resolve(path));
    const ledger = await loadLedger(ledgerPath, true);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const updated = addRecord(ledger, record);
    await writeLedgerAtomically(ledgerPath, updated);
    process.stdout.write(`${JSON.stringify(evaluateLedger(updated), null, 2)}\n`);
    return;
  }
  throw new TypeError(usage());
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
