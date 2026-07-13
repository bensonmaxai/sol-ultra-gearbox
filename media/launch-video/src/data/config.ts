import type { LaunchVideoConfig } from "../types";

export const launchVideoConfig: LaunchVideoConfig = {
  githubUrl: "https://github.com/bensonmaxai/sol-ultra-gearbox",
  voiceoverPath: "voice/narration.wav",
  voiceoverVolume: 0.75,
  showCaptions: true,
  media: {
    routing: { enabled: true, generatedBackground: "generated/routing-background.png", videoEnabled: true, xaiClip: "xai/gear-routing.mp4" },
    failClosed: { enabled: true, generatedBackground: "generated/fail-closed-background.png", videoEnabled: true, xaiClip: "xai/fail-closed-gate.mp4" },
    rollback: { enabled: true, generatedBackground: "generated/rollback-background.png", videoEnabled: true, xaiClip: "xai/rollback-clean-state.mp4" },
    doctor: { enabled: true, recordingPath: "generated/doctor-dry-run.mp4", playbackRate: 3 }
  }
};
