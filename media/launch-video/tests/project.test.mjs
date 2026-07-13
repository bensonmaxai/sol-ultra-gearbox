import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(join(projectRoot, relativePath), "utf8");

const toMs = (timestamp) => {
  const [hours, minutes, secondsAndMilliseconds] = timestamp.split(":");
  const [seconds, milliseconds] = secondsAndMilliseconds.split(",");
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000 + Number(milliseconds);
};

const parseSrt = (source) => source.trim().split(/\n\s*\n/).map((block) => {
  const [index, timing, ...text] = block.split("\n");
  const [start, end] = timing.split(" --> ");
  return { index: Number(index), startMs: toMs(start), endMs: toMs(end), text: text.join("\n") };
});

const listProductionSource = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(directory, entry.name);
    return entry.isDirectory() ? listProductionSource(fullPath) : [fullPath];
  }));
  return nested.flat();
};

test("registers the locked 45-second vertical composition", async () => {
  const root = await read("src/Root.tsx");
  assert.match(root, /id="GearboxLaunchVertical"/);
  assert.match(root, /durationInFrames=\{1350\}/);
  assert.match(root, /fps=\{30\}/);
  assert.match(root, /width=\{1080\}/);
  assert.match(root, /height=\{1920\}/);
});

test("caption pairs are chronological, readable, and exactly fill the runtime", async () => {
  const captions = JSON.parse(await read("src/data/captions.json"));
  assert.ok(captions.length >= 20);
  assert.equal(captions[0].startMs, 0);
  assert.equal(captions.at(-1).endMs, 45_000);
  for (let index = 0; index < captions.length; index += 1) {
    const current = captions[index];
    assert.ok(current.en.length > 0 && current.zhTW.length > 0);
    assert.ok(current.endMs > current.startMs);
    assert.ok(current.endMs - current.startMs >= 1_200);
    assert.ok(current.endMs - current.startMs <= 2_200);
    if (index > 0) assert.equal(captions[index - 1].endMs, current.startMs);
  }
});

test("English and Traditional Chinese SRT files match caption-pair timing", async () => {
  const captions = JSON.parse(await read("src/data/captions.json"));
  const english = parseSrt(await read("captions/launch.en.srt"));
  const traditionalChinese = parseSrt(await read("captions/launch.zh-TW.srt"));
  assert.equal(english.length, captions.length);
  assert.equal(traditionalChinese.length, captions.length);
  captions.forEach((caption, index) => {
    assert.deepEqual(english[index], { index: index + 1, startMs: caption.startMs, endMs: caption.endMs, text: caption.en });
    assert.deepEqual(traditionalChinese[index], { index: index + 1, startMs: caption.startMs, endMs: caption.endMs, text: caption.zhTW });
  });
});

test("caption safe area and required evidence are deterministic", async () => {
  const captions = await read("src/components/CaptionLayer.tsx");
  const video = await read("src/LaunchVideo.tsx");
  const qr = await read("public/gearbox-github-qr.svg");
  assert.match(captions, /CAPTION_BOTTOM_PX = 320/);
  for (const evidence of ["FAIL CLOSED", "23 tests", "6-role smoke PASS", "Global config unchanged", "npm run doctor", "https://github.com/bensonmaxai/sol-ultra-gearbox"]) {
    assert.ok(video.includes(evidence) || (await read("src/data/config.ts")).includes(evidence), `missing ${evidence}`);
  }
  assert.match(qr, /https:\/\/github\.com\/bensonmaxai\/sol-ultra-gearbox/);
  assert.doesNotMatch(video, /animation\s*:|transition\s*:/);
});

test("production source contains no private paths, secrets, or sensitive configuration artifacts", async () => {
  const files = await listProductionSource(join(projectRoot, "src"));
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  for (const forbidden of [/\/Users\//, /~\/\.codex/, /config\.toml/, /reports\//, /(?:sk|ghp)_[A-Za-z0-9_-]{12,}/, /BEGIN [A-Z ]*PRIVATE KEY/]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.match(source, /@remotion\/media/);
  assert.match(source, /@remotion\/captions/);
});
