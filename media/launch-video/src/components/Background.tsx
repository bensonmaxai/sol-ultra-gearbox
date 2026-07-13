import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const Background = () => {
  const frame = useCurrentFrame();
  const beamOffset = interpolate(frame, [0, 1350], [-260, 980]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#090C12", overflow: "hidden" }}>
      <AbsoluteFill style={{ backgroundImage: "radial-gradient(circle at 50% 26%, #202B3D 0%, #111722 34%, #090C12 72%)" }} />
      <div style={{ position: "absolute", width: 900, height: 1500, top: -220, left: beamOffset, background: "linear-gradient(90deg, transparent, rgba(114,222,255,0.08), transparent)", rotate: "-28deg" }} />
      <div style={{ position: "absolute", inset: 0, opacity: 0.19, backgroundImage: "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: "72px 72px" }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(9,12,18,0.05), rgba(9,12,18,0.86))" }} />
    </AbsoluteFill>
  );
};
