import { Audio, Video } from "@remotion/media";
import { AbsoluteFill, staticFile } from "remotion";
import type { SceneMedia } from "../types";

export const OptionalSceneMedia = ({ media }: { media: SceneMedia }) => {
  if (!media.enabled || !media.xaiClip) return null;
  return <Video src={staticFile(media.xaiClip)} muted style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.25 }} />;
};

export const OptionalVoiceover = ({ voiceoverPath }: { voiceoverPath?: string }) => {
  if (!voiceoverPath) return null;
  return <AbsoluteFill><Audio src={staticFile(voiceoverPath)} /></AbsoluteFill>;
};
