import type { LaunchVideoConfig } from "../types";

export const launchVideoConfig: LaunchVideoConfig = {
  githubUrl: "https://github.com/bensonmaxai/sol-ultra-gearbox",
  showCaptions: true,
  media: {
    routing: { enabled: false, generatedBackground: "generated/routing-background.png", xaiClip: "xai/gear-routing.mp4" },
    failClosed: { enabled: false, generatedBackground: "generated/fail-closed-background.png", xaiClip: "xai/fail-closed-gate.mp4" },
    rollback: { enabled: false, generatedBackground: "generated/rollback-background.png", xaiClip: "xai/rollback-clean-state.mp4" }
  }
};
