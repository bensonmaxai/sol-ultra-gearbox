import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OBSERVED_USAGE_REPORT_BASENAME } from "../lib/release-evidence.mjs";

const PLAN_PATH = new URL(
  "../docs/superpowers/plans/2026-07-15-verified-workflow-orchestrator.md",
  import.meta.url,
);
const PACKAGE_PATH = new URL("../package.json", import.meta.url);

function taskSection(source, taskNumber) {
  const marker = `### Task ${taskNumber}:`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must exist`);
  const next = source.indexOf("\n### Task ", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("Task 12 runbook commands match the paid CLI contract", async () => {
  const [plan, packageSource] = await Promise.all([
    readFile(PLAN_PATH, "utf8"),
    readFile(PACKAGE_PATH, "utf8"),
  ]);
  const task12 = taskSection(plan, 12);
  const sddCommand = "rtk npm run smoke:sdd";
  const applyCommand = "rtk node scripts/gearbox.mjs apply --promote-v2 --dispatch-mode active";

  assert.match(task12, /rtk npm run smoke:sdd/);
  assert.ok(
    task12.indexOf(sddCommand) < task12.indexOf(applyCommand),
    "paid SDD smoke must run before active global apply",
  );
  assert.ok(
    task12.includes(`--usage reports/<history-run>/${OBSERVED_USAGE_REPORT_BASENAME}`),
    "runbook usage input must match the CLI's exact observed-usage basename",
  );
  assert.doesNotMatch(task12, /--usage reports\/cost-evidence\.json/);

  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.scripts["smoke:sdd"], "node scripts/gearbox.mjs smoke-sdd");
});
