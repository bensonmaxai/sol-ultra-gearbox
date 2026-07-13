import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { captionPairs } from "../data/captions";

export const CAPTION_BOTTOM_PX = 320;

export const CaptionLayer = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;
  const active = captionPairs.find((caption) => currentMs >= caption.startMs && currentMs < caption.endMs);

  if (!active) return null;
  const cueFrame = frame - (active.startMs / 1000) * fps;
  const opacity = interpolate(cueFrame, [0, 5, 50], [0, 1, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ pointerEvents: "none", justifyContent: "flex-end", alignItems: "center", padding: `0 96px ${CAPTION_BOTTOM_PX}px` }}>
      <div style={{ width: "100%", maxWidth: 900, opacity, textAlign: "center", backgroundColor: "rgba(8, 11, 17, 0.82)", border: "1px solid rgba(232,237,244,0.20)", borderRadius: 26, padding: "26px 34px", boxShadow: "0 14px 50px rgba(0,0,0,0.32)" }}>
        <div style={{ color: "#F7F9FC", fontFamily: "Arial, sans-serif", fontSize: 46, fontWeight: 700, lineHeight: 1.2 }}>{active.en}</div>
        <div style={{ color: "#B8C6D9", fontFamily: "Arial, sans-serif", fontSize: 40, fontWeight: 500, lineHeight: 1.3, marginTop: 12 }}>{active.zhTW}</div>
      </div>
    </AbsoluteFill>
  );
};
