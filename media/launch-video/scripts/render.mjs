import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2];
const projectRoot = resolve(import.meta.dirname, "..");
const renders = resolve(projectRoot, "renders");
await mkdir(renders, { recursive: true });

const variants = {
  still: ["still", "src/index.ts", "GearboxLaunchVertical", resolve(renders, "cover.png"), "--frame=120", "--image-format=png", "--scale=0.5"],
  bilingual: ["render", "src/index.ts", "GearboxLaunchVertical", resolve(renders, "gearbox-launch-bilingual.mp4"), "--codec=h264", "--pixel-format=yuv420p"],
  clean: ["render", "src/index.ts", "GearboxLaunchVertical", resolve(renders, "gearbox-launch-clean.mp4"), "--codec=h264", "--pixel-format=yuv420p", "--props={\"showCaptions\":false}"],
};

if (!(mode in variants)) {
  throw new Error("Usage: node scripts/render.mjs <still|bilingual|clean>");
}

const result = spawnSync("npx", ["remotion", ...variants[mode]], { cwd: projectRoot, stdio: "inherit" });
process.exitCode = result.status ?? 1;
