import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(projectRoot, "../..");
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
  assert.match(root, /import \{ launchVideoConfig \} from "\.\/data\/config"/);
  assert.match(root, /defaultProps=\{launchVideoConfig\}/);
  assert.doesNotMatch(root, /doctor:\s*\{/);
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

test("locked bilingual narration starts and ends inside each scene boundary", async () => {
  const captions = JSON.parse(await read("src/data/captions.json"));
  const scenes = [
    [0, 6_000, "Most AI agent workflows trust what a model says it is. Sol Ultra Gearbox verifies what actually ran.", "多數 AI 代理工作流程只相信模型自稱的身分。Sol Ultra Gearbox 驗證實際執行的是誰。"],
    [6_000, 13_000, "It routes Codex work to typed Sol, Terra, and Luna roles.", "它會將 Codex 工作分派給明確定義的 Sol、Terra 與 Luna 角色。"],
    [13_000, 23_000, "Then it checks the real model, reasoning effort, sandbox, lineage, token usage, and filesystem scope from persisted runtime metadata.", "再從保存的執行中繼資料檢查實際模型、推理強度、沙箱、父子關係、Token 使用量與檔案系統範圍。"],
    [23_000, 29_000, "If anything is missing or mismatched, it fails closed.", "任何資料缺失或不一致，系統就會 fail closed。"],
    [29_000, 38_000, "The built-in doctor validates six role profiles. Dry-run previews global changes, while managed apply includes rollback.", "內建 doctor 可驗證六個角色設定；dry-run 會預覽全域變更，受控 apply 則包含回滾。"],
    [38_000, 45_000, "This release passed twenty-three tests and a six-role runtime smoke test. If your team needs multi-agent workflows you can audit, reproduce, and reverse, try Sol Ultra Gearbox on GitHub.", "這個版本已通過 23 項測試與六角色 runtime smoke test。需要可稽核、可重現、可逆的多代理工作流，歡迎到 GitHub 試用。"],
  ];
  for (const [startMs, endMs, en, zhTW] of scenes) {
    const sceneCaptions = captions.filter((caption) => caption.startMs >= startMs && caption.endMs <= endMs);
    assert.equal(sceneCaptions[0].startMs, startMs);
    assert.equal(sceneCaptions.at(-1).endMs, endMs);
    assert.equal(sceneCaptions.map((caption) => caption.en).join(" "), en);
    assert.equal(sceneCaptions.map((caption) => caption.zhTW).join(""), zhTW);
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
    assert.deepEqual(traditionalChinese[index], { index: index + 1, startMs: caption.startMs, endMs: caption.endMs, text: caption.zhTW.trimEnd() });
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

test("public release claims remain backed by sanitized persisted evidence", async () => {
  const evidence = await readFile(join(repositoryRoot, "docs/RELEASE_EVIDENCE.md"), "utf8");
  assert.match(evidence, /Node unit tests \| 23 passed, 0 failed/);
  assert.match(evidence, /Cost-bearing six-role smoke/);
  assert.match(evidence, /persisted lineage, exact parent and child runtime\s+identity/);
  assert.match(evidence, /global config contents were identical\s+before and after the isolated smoke/);
  assert.doesNotMatch(evidence, /\/Users\//);
});

test("optional media uses approved PNGs without requesting missing videos and keeps Doctor fallback", async () => {
  const config = await read("src/data/config.ts");
  const media = await read("src/components/OptionalMedia.tsx");
  const video = await read("src/LaunchVideo.tsx");
  for (const background of ["routing-background.png", "fail-closed-background.png", "rollback-background.png"]) {
    assert.match(config, new RegExp(`enabled: true, generatedBackground: "generated/${background}", videoEnabled: false`));
  }
  assert.match(media, /<Img src=\{staticFile\(media\.generatedBackground\)\}/);
  assert.match(media, /media\.videoEnabled && media\.xaiClip/);
  assert.match(config, /doctor: \{ enabled: true, recordingPath: "generated\/doctor-dry-run\.mp4", playbackRate: 3 \}/);
  assert.match(media, /playbackRate=\{media\.playbackRate\}/);
  assert.match(media, /muted playbackRate/);
  assert.match(media, /objectFit="contain"/);
  assert.match(video, /config\.media\.doctor\.enabled \? <OptionalDoctorRecording/);
  assert.match(video, /config\.media\.doctor\.enabled \? null : <DoctorTerminal/);
});

test("VHS recording runs from the repository root and writes the package-local MP4", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const tape = await read("tapes/doctor-dry-run.tape");
  assert.equal(packageJson.scripts["record:doctor"], "cd ../.. && vhs media/launch-video/tapes/doctor-dry-run.tape");
  assert.match(tape, /^Output media\/launch-video\/public\/generated\/doctor-dry-run\.mp4/m);
  assert.match(tape, /Set TypingSpeed 1ms/);
  assert.match(tape, /Set Shell "bash"/);
  assert.match(tape, /npm run --silent doctor/);
  assert.match(tape, /Wait\+Screen \/GEARBOX_DOCTOR_PASS\//);
  assert.match(tape, /Wait\+Screen \/GEARBOX_DRY_RUN_PASS\//);
  assert.doesNotMatch(tape, /raw reports|config\.toml|\/Users\//);
});

test("VHS jq gates fail closed and emit sentinels only for complete PASS data", () => {
  const runGate = (filter, input) => spawnSync("jq", ["-c", "-f", join(projectRoot, filter)], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  const validDoctor = { pass: true, roleChecks: Array.from({ length: 6 }, (_, index) => ({ role: index })) };
  const validDryRun = { pass: true, changes: { config: { changed: false }, agents: { changed: true }, installedRoleCount: 6, secretsCopiedToReport: false } };
  const doctorPass = runGate("tapes/jq/doctor-pass.jq", validDoctor);
  const dryRunPass = runGate("tapes/jq/apply-dry-run-pass.jq", validDryRun);
  assert.equal(doctorPass.status, 0);
  assert.match(doctorPass.stdout, /GEARBOX_DOCTOR_PASS/);
  assert.equal(dryRunPass.status, 0);
  assert.match(dryRunPass.stdout, /GEARBOX_DRY_RUN_PASS/);
  for (const invalidDoctor of [{ ...validDoctor, pass: false }, { pass: true, roleChecks: validDoctor.roleChecks.slice(0, 5) }, { pass: true }]) {
    const result = runGate("tapes/jq/doctor-pass.jq", invalidDoctor);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /GEARBOX_DOCTOR_PASS/);
  }
  for (const invalidDryRun of [
    { ...validDryRun, pass: false },
    { ...validDryRun, changes: { ...validDryRun.changes, config: {} } },
    { ...validDryRun, changes: { ...validDryRun.changes, agents: { changed: "yes" } } },
    { ...validDryRun, changes: { ...validDryRun.changes, installedRoleCount: 5 } },
    { ...validDryRun, changes: { ...validDryRun.changes, secretsCopiedToReport: true } },
    { pass: true, changes: {} },
  ]) {
    const result = runGate("tapes/jq/apply-dry-run-pass.jq", invalidDryRun);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /GEARBOX_DRY_RUN_PASS/);
  }
});

test("xAI dry-run script maps all approved PNGs to local-only request validation", async () => {
  const script = await read("scripts/xai-dry-run.sh");
  assert.match(script, /python3 "\$XAI_VIDEO_SCRIPT" generate/);
  for (const mapping of [
    ["routing-background.png", "01-gear-data-streams.md", "gear-routing.mp4", "gear-routing.json"],
    ["fail-closed-background.png", "02-fail-closed-gate.md", "fail-closed-gate.mp4", "fail-closed-gate.json"],
    ["rollback-background.png", "03-rollback-clean-state.md", "rollback-clean-state.mp4", "rollback-clean-state.json"],
  ]) {
    for (const value of mapping) assert.ok(script.includes(value));
  }
  for (const flag of ["--duration 4", "--aspect-ratio 9:16", "--resolution 720p", "--out", "--manifest", "--dry-run"]) assert.ok(script.includes(flag));
  assert.match(script, /\$\{CODEX_HOME:-\$HOME\/.codex\}/);
  assert.doesNotMatch(script, /\/Users\//);
});

test("owner-review keyframes have separate reproducible still-image prompts", async () => {
  for (const prompt of ["01-routing-data-streams.md", "02-fail-closed-gate.md", "03-rollback-clean-state.md"]) {
    const source = await read(`prompts/keyframes/${prompt}`);
    assert.match(source, /vertical 9:16/);
    assert.match(source, /No text/);
    assert.doesNotMatch(source, /4-second|720p|image-to-video/);
  }
});

test("generated delivery artifacts stay ignored while reproducible source stays tracked", () => {
  const generated = [
    "outputs/social/sol-ultra-gearbox-launch/gearbox-launch-bilingual.mp4",
    "media/launch-video/public/generated/routing-background.png",
    "media/launch-video/public/voice/narration.wav",
    "media/launch-video/public/xai/gear-routing.mp4",
    "media/launch-video/renders/gearbox-launch-clean.mp4",
    "media/launch-video/receipts/gear-routing.json",
  ];
  for (const path of generated) {
    assert.equal(spawnSync("git", ["check-ignore", "-q", path], { cwd: repositoryRoot }).status, 0, `${path} must be ignored`);
  }
  for (const path of [
    "media/launch-video/src/Root.tsx",
    "media/launch-video/prompts/keyframes/01-routing-data-streams.md",
    "media/launch-video/tapes/jq/doctor-pass.jq",
  ]) {
    assert.equal(spawnSync("git", ["check-ignore", "-q", path], { cwd: repositoryRoot }).status, 1, `${path} must remain source-controlled`);
  }
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
