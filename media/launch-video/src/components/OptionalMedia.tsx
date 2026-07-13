import { Audio, Video } from "@remotion/media";
import { AbsoluteFill, Img, staticFile } from "remotion";
import type { DoctorMedia, SceneMedia } from "../types";

export const OptionalSceneMedia = ({ media }: { media: SceneMedia }) => {
  if (!media.enabled) return null;
  return <AbsoluteFill style={{ overflow: "hidden", opacity: 0.26 }}>
    <Img src={staticFile(media.generatedBackground)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    {media.videoEnabled && media.xaiClip ? <Video src={staticFile(media.xaiClip)} muted objectFit="cover" style={{ width: "100%", height: "100%", opacity: 0.62 }} /> : null}
  </AbsoluteFill>;
};

export const OptionalDoctorRecording = ({ media }: { media: DoctorMedia }) => {
  if (!media.enabled) return null;
  return <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#05070B" }}><Video src={staticFile(media.recordingPath)} muted playbackRate={media.playbackRate} objectFit="contain" style={{ width: "100%", height: "100%", opacity: 0.92 }} /></AbsoluteFill>;
};

export const OptionalVoiceover = ({ voiceoverPath }: { voiceoverPath?: string }) => {
  if (!voiceoverPath) return null;
  return <AbsoluteFill><Audio src={staticFile(voiceoverPath)} /></AbsoluteFill>;
};
