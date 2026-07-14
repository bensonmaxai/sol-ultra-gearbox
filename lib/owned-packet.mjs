import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const OWNED_PACKET_DIRECTORY = /^sol-ultra-gearbox-v2-packet-dispatch-[A-Za-z0-9]+$/;

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function ownedMetadata(metadata, type) {
  return (
    (type === "directory" ? metadata.isDirectory() : metadata.isFile())
    && !metadata.isSymbolicLink()
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    && (metadata.mode & 0o077) === 0
  );
}

async function resolveOwnedPacket(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("owned dispatch packet path is required");
  }
  const requestedTempRoot = resolve(tmpdir());
  const tempRoot = await realpath(requestedTempRoot);
  const requested = resolve(path);
  const requestedFromTemp = relative(requestedTempRoot, requested);
  if (requestedFromTemp === "" || requestedFromTemp === ".." || requestedFromTemp.startsWith(`..${sep}`)) {
    throw new TypeError("dispatch packet must be beneath an owned temporary directory");
  }
  let requestedCurrent = requestedTempRoot;
  const requestedParts = requestedFromTemp.split(sep);
  for (const part of requestedParts.slice(0, -1)) {
    requestedCurrent = join(requestedCurrent, part);
    if ((await lstat(requestedCurrent)).isSymbolicLink()) {
      throw new TypeError("dispatch packet must not traverse symlinks");
    }
  }
  const requestedMetadata = await lstat(requested);
  if (requestedMetadata.isSymbolicLink()) throw new TypeError("dispatch packet must not be a symlink");
  const absolute = await realpath(requested);
  const fromTemp = relative(tempRoot, absolute);
  if (fromTemp === "" || fromTemp === ".." || fromTemp.startsWith(`..${sep}`) || !fromTemp.includes(sep)) {
    throw new TypeError("dispatch packet must be beneath an owned temporary directory");
  }
  const [directoryName] = fromTemp.split(sep);
  if (!OWNED_PACKET_DIRECTORY.test(directoryName)) {
    throw new TypeError("dispatch packet must be beneath an owned temporary directory");
  }
  const ownedDirectory = join(tempRoot, directoryName);
  if (dirname(ownedDirectory) !== tempRoot || (await realpath(ownedDirectory)) !== ownedDirectory) {
    throw new TypeError("dispatch packet directory must be a physical owned temporary directory");
  }
  if (!ownedMetadata(await lstat(ownedDirectory), "directory")) {
    throw new TypeError("dispatch packet directory must be private and non-symlinked");
  }
  let current = ownedDirectory;
  while (current !== dirname(absolute)) {
    if (!ownedMetadata(await lstat(current), "directory")) {
      throw new TypeError("dispatch packet directory must be private and non-symlinked");
    }
    current = join(current, relative(current, absolute).split(sep)[0]);
  }
  const parent = await lstat(dirname(absolute));
  const packet = await lstat(absolute);
  if (!ownedMetadata(parent, "directory") || !ownedMetadata(packet, "file")) {
    throw new TypeError("dispatch packet must be a private regular file");
  }
  return { absolute, packet };
}

export async function readOwnedPacket(path, { consume = false } = {}) {
  if (typeof consume !== "boolean") throw new TypeError("packet consume must be a boolean");
  const owned = await resolveOwnedPacket(path);
  const handle = await open(owned.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    const metadata = await handle.stat();
    if (!sameFile(owned.packet, metadata) || !ownedMetadata(metadata, "file")) {
      throw new TypeError("dispatch packet changed while opening");
    }
    source = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
  let packet;
  try {
    packet = JSON.parse(source);
  } catch {
    throw new TypeError("dispatch packet must contain JSON");
  }
  if (consume) {
    const current = await lstat(owned.absolute);
    if (!sameFile(owned.packet, current) || !ownedMetadata(current, "file")) {
      throw new TypeError("dispatch packet changed before consume");
    }
    await unlink(owned.absolute);
  }
  return packet;
}
