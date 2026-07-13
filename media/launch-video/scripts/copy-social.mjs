import { access, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const destination = resolve(projectRoot, "../../outputs/social/sol-ultra-gearbox-launch");
const artifacts = [
  ["renders/gearbox-launch-bilingual.mp4", "gearbox-launch-bilingual.mp4"],
  ["renders/gearbox-launch-clean.mp4", "gearbox-launch-clean.mp4"],
  ["renders/cover.png", "cover.png"],
  ["captions/launch.en.srt", "launch.en.srt"],
  ["captions/launch.zh-TW.srt", "launch.zh-TW.srt"],
  ["social/zh-TW.md", "social-copy-zh-TW.md"],
];

for (const [source] of artifacts) {
  await access(resolve(projectRoot, source), constants.R_OK).catch(() => {
    throw new Error(`Missing artifact: ${source}. Run the relevant render script first.`);
  });
}
await mkdir(destination, { recursive: true });
for (const [source, filename] of artifacts) {
  await copyFile(resolve(projectRoot, source), resolve(destination, filename));
}
console.log(`Copied ${artifacts.length} artifacts to ${destination}`);
