import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOwnedPacket } from "../lib/owned-packet.mjs";

async function fixture(t) {
  const owned = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-packet-dispatch-"));
  const path = join(owned, "packet.json");
  await writeFile(path, '{"packet":"valid"}\n', { mode: 0o600 });
  t.after(() => rm(owned, { recursive: true, force: true }));
  return { owned, path };
}

test("owned packets require the physical private dispatch temp root and consume the same file", async (t) => {
  const { path } = await fixture(t);
  assert.deepEqual(await readOwnedPacket(path, { consume: false }), { packet: "valid" });
  assert.deepEqual(await readOwnedPacket(path, { consume: true }), { packet: "valid" });
  await assert.rejects(access(path));
});

test("owned packets reject unsafe files, symlinks, and paths outside the managed prefix", async (t) => {
  const { owned, path } = await fixture(t);
  await chmod(path, 0o644);
  await assert.rejects(readOwnedPacket(path, { consume: false }), /private regular file/);
  await chmod(path, 0o600);
  const linked = join(owned, "linked.json");
  await symlink(path, linked);
  await assert.rejects(readOwnedPacket(linked, { consume: false }), /must not be a symlink/);
  const outside = await mkdtemp(join(tmpdir(), "owned-packet-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsidePath = join(outside, "packet.json");
  await writeFile(outsidePath, '{"packet":"outside"}\n', { mode: 0o600 });
  await assert.rejects(readOwnedPacket(outsidePath, { consume: false }), /owned temporary directory/);
});

test("owned packets reject malformed JSON without consuming the packet", async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, "not json\n", { mode: 0o600 });
  await assert.rejects(readOwnedPacket(path, { consume: true }), /must contain JSON/);
  assert.equal(await readFile(path, "utf8"), "not json\n");
});

test("owned packets reject a symlinked parent beneath the managed directory", async (t) => {
  const { owned } = await fixture(t);
  const physical = join(owned, "physical");
  const linked = join(owned, "linked");
  await mkdir(physical, { mode: 0o700 });
  await writeFile(join(physical, "packet.json"), '{"packet":"valid"}\n', { mode: 0o600 });
  await symlink(physical, linked);
  await assert.rejects(readOwnedPacket(join(linked, "packet.json"), { consume: false }), /must not traverse symlinks/);
});
