import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { appendPrivateJsonl, readPrivateJsonl } from "../lib/private-jsonl.mjs";

const execFileAsync = promisify(execFile);
const valid = () => ({ pass: true, errors: [] });

async function waitForCount(path, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readdir(path)).length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("private JSONL workers did not reach the barrier");
}

test("private JSONL creates 0700 parent and 0600 complete records", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-jsonl-"));
  const path = join(root, "owned", "ledger.jsonl");
  appendPrivateJsonl(path, { sequence: 1 }, { defaultPath: path, validate: valid });
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  assert.deepEqual(readPrivateJsonl(path, { defaultPath: path, validate: valid }), [{ sequence: 1 }]);
});

test("private JSONL writes canonical JSON objects and rejects lossy values", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-jsonl-object-"));
  const path = join(root, "ledger.jsonl");
  appendPrivateJsonl(path, { z: 1, a: 2 }, { defaultPath: path, validate: valid });
  assert.equal(await readFile(path, "utf8"), '{"a":2,"z":1}\n');
  for (const value of [[], "text", { missing: undefined }, { invalid: Number.NaN }]) {
    assert.throws(() => appendPrivateJsonl(path, value, { defaultPath: path, validate: valid }), /JSON object/);
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => appendPrivateJsonl(path, cyclic, { defaultPath: path, validate: valid }), /JSON object/);
  assert.equal((await readFile(path, "utf8")).split("\n").filter(Boolean).length, 1);
});

test("private JSONL rejects unsafe parents, symlink files, and incomplete records", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-jsonl-unsafe-"));
  const unowned = join(root, "unowned");
  await mkdir(unowned, { mode: 0o700 });
  await chmod(unowned, 0o755);
  assert.throws(
    () => appendPrivateJsonl(join(unowned, "ledger.jsonl"), { sequence: 1 }, { defaultPath: join(root, "default.jsonl"), validate: valid }),
    /owned 0700 directory/,
  );

  const owned = join(root, "owned");
  await mkdir(owned, { mode: 0o700 });
  const linkedParent = join(root, "linked-parent");
  await symlink(owned, linkedParent);
  assert.throws(
    () => readPrivateJsonl(join(linkedParent, "missing.jsonl"), { defaultPath: join(linkedParent, "missing.jsonl"), validate: valid }),
    /symlinked parent|directory/,
  );
  const target = join(root, "target.jsonl");
  await writeFile(target, "{}\n", { mode: 0o600 });
  const linked = join(owned, "linked.jsonl");
  await symlink(target, linked);
  assert.throws(() => readPrivateJsonl(linked, { defaultPath: linked, validate: valid }), /regular file/);

  const incomplete = join(owned, "incomplete.jsonl");
  await writeFile(incomplete, "{}", { mode: 0o600 });
  assert.throws(() => appendPrivateJsonl(incomplete, { sequence: 2 }, { defaultPath: incomplete, validate: valid }), /incomplete record/);
  assert.throws(() => readPrivateJsonl(incomplete, { defaultPath: incomplete, validate: valid }), /incomplete record/);

  const wrongMode = join(owned, "wrong-mode.jsonl");
  await writeFile(wrongMode, "{}\n", { mode: 0o644 });
  assert.throws(() => readPrivateJsonl(wrongMode, { defaultPath: wrongMode, validate: valid }), /owned 0600 file/);
});

test("only the declared default parent may be repaired to 0700", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-jsonl-mode-"));
  const parent = join(root, "reports");
  const path = join(parent, "ledger.jsonl");
  await mkdir(parent, { mode: 0o700 });
  await chmod(parent, 0o755);
  appendPrivateJsonl(path, { sequence: 1 }, { defaultPath: path, validate: valid });
  assert.equal((await stat(parent)).mode & 0o777, 0o700);
});

test("private JSONL replay validates every line without returning partial data", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-jsonl-replay-"));
  const parent = join(root, "owned");
  const path = join(parent, "ledger.jsonl");
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, '{"sequence":1}\n{"sequence":2}\n', { mode: 0o600 });
  const validation = (value) => value.sequence === 1
    ? { pass: true, errors: [] }
    : { pass: false, errors: ["sequence rejected"] };
  assert.throws(() => readPrivateJsonl(path, { defaultPath: path, validate: validation }), /sequence rejected/);
});

test("private JSONL retains eight complete concurrent O_APPEND records", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-jsonl-concurrent-"));
  const parent = join(root, "ledger");
  const ready = join(root, "ready");
  const start = join(root, "start");
  const path = join(parent, "ledger.jsonl");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(ready, { mode: 0o700 });
  const moduleUrl = new URL("../lib/private-jsonl.mjs", import.meta.url).href;
  const worker = [
    'const { appendPrivateJsonl } = await import(process.env.MODULE_URL);',
    'import { existsSync, writeFileSync } from "node:fs";',
    'writeFileSync(`${process.env.READY_DIR}/${process.env.RECORD_ID}`, "ready");',
    'while (!existsSync(process.env.START_PATH)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    'appendPrivateJsonl(process.env.LEDGER_PATH, { sequence: Number(process.env.RECORD_ID) }, { defaultPath: process.env.LEDGER_PATH, validate: () => ({ pass: true, errors: [] }) });',
  ].join("\n");
  const workers = Array.from({ length: 8 }, (_, index) => execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", worker],
    {
      env: {
        ...process.env,
        MODULE_URL: moduleUrl,
        LEDGER_PATH: path,
        READY_DIR: ready,
        RECORD_ID: String(index),
        START_PATH: start,
      },
    },
  ));
  await waitForCount(ready, 8);
  await writeFile(start, "go");
  await Promise.all(workers);
  const records = readPrivateJsonl(path, { defaultPath: path, validate: valid });
  assert.equal(records.length, 8);
  assert.deepEqual(new Set(records.map((record) => record.sequence)), new Set([0, 1, 2, 3, 4, 5, 6, 7]));
});
