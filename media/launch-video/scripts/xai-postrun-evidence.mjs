import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const clips = [
  { id: "gear-routing", file: "public/xai/gear-routing.mp4", receipt: "receipts/gear-routing.json" },
  { id: "fail-closed-gate", file: "public/xai/fail-closed-gate.mp4", receipt: "receipts/fail-closed-gate.json" },
  { id: "rollback-clean-state", file: "public/xai/rollback-clean-state.mp4", receipt: "receipts/rollback-clean-state.json" },
];

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const evidenceDate = argumentValue("--evidence-date");
const output = resolve(projectRoot, argumentValue("--out") ?? "manifests/xai-generation-evidence.json");
if (!/^\d{4}-\d{2}-\d{2}$/.test(evidenceDate ?? "")) {
  throw new Error("--evidence-date must be supplied as YYYY-MM-DD");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const probe = (file) => {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration:stream=codec_name,width,height,pix_fmt,r_frame_rate",
    "-of", "json",
    file,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffprobe failed for ${file}: ${result.stderr.trim()}`);
  const parsed = JSON.parse(result.stdout);
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`No primary video stream found in ${file}`);
  return {
    codec: stream.codec_name,
    pixelFormat: stream.pix_fmt,
    width: stream.width,
    height: stream.height,
    fps: stream.r_frame_rate,
    durationSeconds: Number(parsed.format?.duration),
  };
};

const receiptEvidence = async ({ receipt, file, bytes, fileSha256 }) => {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolve(projectRoot, receipt), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        availability: "unavailable",
        reason: "No local receipt was preserved; no provider request ID was reconstructed.",
      };
    }
    throw error;
  }
  if (parsed.output !== file || parsed.bytes !== bytes || parsed.sha256 !== fileSha256) {
    throw new Error(`Receipt does not match local clip: ${receipt}`);
  }
  if (parsed.status !== "done" || parsed.downloaded !== true) {
    throw new Error(`Receipt is not a completed downloaded generation: ${receipt}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(parsed.request_id ?? "")) {
    throw new Error(`Receipt request ID is missing or invalid: ${receipt}`);
  }
  return {
    availability: "recovered",
    completeness: parsed.receipt_completeness,
    status: parsed.status,
    requestedModel: parsed.model,
    mode: parsed.mode,
    endpoint: parsed.endpoint,
    requestIdSha256: sha256(parsed.request_id),
    recoveryMethod: parsed.receipt_recovery?.method,
  };
};

const clipEvidence = [];
for (const clip of clips) {
  const file = resolve(projectRoot, clip.file);
  const payload = await readFile(file);
  const metadata = await stat(file);
  const fileSha256 = sha256(payload);
  clipEvidence.push({
    id: clip.id,
    file: clip.file,
    bytes: metadata.size,
    sha256: fileSha256,
    media: probe(file),
    receipt: await receiptEvidence({ ...clip, bytes: metadata.size, fileSha256 }),
  });
}

const manifest = {
  schemaVersion: 1,
  evidenceType: "sanitized-xai-image-to-video-postrun",
  evidenceDate,
  provider: "xAI",
  requestedModel: "grok-imagine-video",
  runtimeModelVerification: "provider receipt records the requested model; no separate runtime-model field was returned",
  generationPolicy: {
    ownerAuthorizedRequests: 3,
    automaticRetryAllowed: false,
    observedSuccessfulOutputs: clipEvidence.filter((clip) => clip.receipt.status === "done").length,
  },
  clips: clipEvidence,
};

await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote sanitized xAI post-run evidence: ${output}`);
