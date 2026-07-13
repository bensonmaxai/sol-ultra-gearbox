import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { ReactNode } from "react";
import { Background } from "./components/Background";
import { BrandMark } from "./components/BrandMark";
import { CaptionLayer } from "./components/CaptionLayer";
import { OptionalDoctorRecording, OptionalSceneMedia, OptionalVoiceover } from "./components/OptionalMedia";
import { QrCode } from "./components/QrCode";
import type { LaunchVideoConfig } from "./types";

const COLORS = { sol: "#FFCC66", terra: "#72DEFF", luna: "#C39BFF", ink: "#101722", text: "#F7F9FC", muted: "#A9B7C8" };
const sec = (seconds: number, fps: number) => Math.round(seconds * fps);
const fade = (frame: number, duration = 12) => interpolate(frame, [0, duration], [0, 1], { extrapolateRight: "clamp" });

const Topline = ({ label }: { label: string }) => (
  <div style={{ color: COLORS.muted, fontFamily: "Arial, sans-serif", fontSize: 29, fontWeight: 700, letterSpacing: 5, textTransform: "uppercase" }}>{label}</div>
);

const IntroScene = () => {
  const frame = useCurrentFrame();
  const offset = interpolate(frame, [0, 18, 80], [-70, 8, 0], { extrapolateRight: "clamp" });
  const glitch = frame < 24 ? (frame % 4) * 5 : 0;
  return <SceneShell><div style={{ display: "flex", alignItems: "center", gap: 30, opacity: fade(frame), translate: `${offset}px 0` }}><BrandMark size={200} /><Topline label="Runtime evidence" /></div><div style={{ marginTop: 92, color: COLORS.text, fontFamily: "Arial, sans-serif", fontSize: 104, lineHeight: 1.02, fontWeight: 800, letterSpacing: -4, maxWidth: 850, translate: `${glitch}px 0` }}>Don't trust the label.<br /><span style={{ color: COLORS.sol }}>Verify the runtime.</span></div><AgentLabels /></SceneShell>;
};

const AgentLabels = () => <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginTop: 70 }}>{[["SOL ROOT", COLORS.sol], ["TERRA", COLORS.terra], ["LUNA", COLORS.luna]].map(([label, color]) => <div key={label} style={{ color, border: `1px solid ${color}`, borderRadius: 100, padding: "13px 22px", fontFamily: "Arial, sans-serif", fontSize: 30, fontWeight: 700, letterSpacing: 2 }}>{label}</div>)}</div>;

const RoutingScene = ({ config }: { config: LaunchVideoConfig }) => {
  const frame = useCurrentFrame();
  const roles = [["Sol", "root verification", COLORS.sol], ["Terra", "explore / implement", COLORS.terra], ["Luna", "mechanical reads", COLORS.luna]];
  return <SceneShell><OptionalSceneMedia media={config.media.routing} /><Topline label="Typed routing" /><div style={{ display: "grid", gridTemplateColumns: "290px 1fr", gap: 38, alignItems: "center", marginTop: 52 }}><div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}><BrandMark size={270} /><div style={{ color: COLORS.sol, fontSize: 38, fontFamily: "Arial, sans-serif", fontWeight: 800, marginTop: 12 }}>SOL ROOT</div></div><div style={{ display: "grid", gap: 22 }}>{roles.map(([name, detail, color], index) => <div key={name} style={{ display: "flex", alignItems: "center", gap: 24, opacity: fade(frame - index * 13), translate: `${interpolate(frame - index * 13, [0, 20], [60, 0], { extrapolateRight: "clamp" })}px 0` }}><div style={{ width: 34, height: 34, borderRadius: 20, backgroundColor: color }} /><div><div style={{ color, fontSize: 54, fontWeight: 800, fontFamily: "Arial, sans-serif" }}>{name}</div><div style={{ color: COLORS.muted, fontSize: 30, marginTop: 2, fontFamily: "Arial, sans-serif" }}>{detail}</div></div></div>)}</div></div></SceneShell>;
};

const ValidationScene = () => {
  const frame = useCurrentFrame();
  const checks = ["Model", "Effort", "Sandbox", "Lineage", "Tokens", "Filesystem"];
  return <SceneShell><Topline label="Persisted runtime metadata" /><div style={{ color: COLORS.text, fontFamily: "Arial, sans-serif", fontSize: 75, fontWeight: 800, marginTop: 38 }}>Verify what actually ran.</div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 56 }}>{checks.map((check, index) => <div key={check} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "25px 30px", opacity: fade(frame - index * 13), border: "1px solid rgba(232,237,244,0.20)", borderRadius: 18, background: "rgba(16,23,34,0.68)" }}><span style={{ color: COLORS.text, fontFamily: "Arial, sans-serif", fontWeight: 700, fontSize: 42 }}>{check}</span><span style={{ color: COLORS.terra, fontFamily: "Arial, sans-serif", fontSize: 31, fontWeight: 800 }}>CHECKED</span></div>)}</div></SceneShell>;
};

const FailClosedScene = ({ config }: { config: LaunchVideoConfig }) => {
  const frame = useCurrentFrame();
  const gate = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return <SceneShell><OptionalSceneMedia media={config.media.failClosed} /><Topline label="Mismatched runtime" /><div style={{ color: "#FF7E7E", fontFamily: "Arial, sans-serif", fontSize: 108, fontWeight: 900, letterSpacing: 2, marginTop: 72, opacity: fade(frame) }}>FAIL CLOSED</div><div style={{ marginTop: 54, border: "3px solid #FF7E7E", borderRadius: 28, padding: "38px 42px", backgroundColor: "rgba(92,22,28,0.32)", scale: `${gate}` }}><div style={{ color: COLORS.text, fontSize: 37, fontFamily: "monospace" }}>expected: terra_worker</div><div style={{ color: "#FFB8B8", fontSize: 37, fontFamily: "monospace", marginTop: 18 }}>actual: unverified runtime</div><div style={{ color: "#FF7E7E", fontSize: 29, fontFamily: "monospace", marginTop: 28 }}>BLOCKED — metadata mismatch</div></div></SceneShell>;
};

const DoctorTerminal = () => <><div style={{ color: COLORS.text, fontFamily: "Arial, sans-serif", fontWeight: 800, fontSize: 76, marginTop: 42 }}>Preview safely.<br /><span style={{ color: COLORS.terra }}>Apply deliberately.</span></div><div style={{ marginTop: 54, backgroundColor: "#05070B", border: "1px solid rgba(114,222,255,0.44)", borderRadius: 22, padding: 34, fontFamily: "monospace", fontSize: 31, lineHeight: 1.75, color: "#DCE8F6" }}><div><span style={{ color: COLORS.terra }}>$</span> npm run doctor</div><div style={{ color: "#A6F3C2" }}>GEARBOX_DOCTOR_PASS</div><div style={{ marginTop: 22 }}><span style={{ color: COLORS.terra }}>$</span> apply --dry-run</div><div style={{ color: "#A6F3C2" }}>PASS · preview only · rollback ready</div></div></>;

const DoctorScene = ({ config }: { config: LaunchVideoConfig }) => <SceneShell>{config.media.doctor.enabled ? <OptionalDoctorRecording media={config.media.doctor} /> : null}<div style={{ position: "relative", zIndex: 1 }}><Topline label="Safe verification" />{config.media.doctor.enabled ? null : <DoctorTerminal />}</div></SceneShell>;

const EvidenceScene = ({ config }: { config: LaunchVideoConfig }) => <SceneShell><OptionalSceneMedia media={config.media.rollback} /><div style={{ display: "flex", alignItems: "center", gap: 24 }}><BrandMark size={135} /><Topline label="Release evidence" /></div><div style={{ display: "grid", gap: 18, marginTop: 40 }}>{["23 tests", "6-role smoke PASS", "Global config unchanged"].map((evidence) => <div key={evidence} style={{ color: COLORS.text, fontFamily: "Arial, sans-serif", fontSize: 53, fontWeight: 800, padding: "22px 28px", borderLeft: `8px solid ${COLORS.sol}`, backgroundColor: "rgba(16,23,34,0.72)" }}>{evidence}</div>)}</div><div style={{ display: "flex", alignItems: "center", gap: 34, marginTop: 48 }}><QrCode /><div style={{ color: COLORS.text, fontFamily: "Arial, sans-serif" }}><div style={{ fontSize: 47, fontWeight: 800, lineHeight: 1.08 }}>Sol Ultra Gearbox</div><div style={{ color: COLORS.terra, fontSize: 29, fontWeight: 700, lineHeight: 1.3, marginTop: 18, overflowWrap: "anywhere" }}>{config.githubUrl}</div></div></div></SceneShell>;

const SceneShell = ({ children }: { children: ReactNode }) => <AbsoluteFill style={{ padding: "144px 100px 0", fontFamily: "Arial, sans-serif" }}>{children}</AbsoluteFill>;

export const LaunchVideo = (config: LaunchVideoConfig) => {
  const { fps } = useVideoConfig();
  return <AbsoluteFill><Background /><Sequence from={sec(0, fps)} durationInFrames={sec(6, fps)}><IntroScene /></Sequence><Sequence from={sec(6, fps)} durationInFrames={sec(7, fps)}><RoutingScene config={config} /></Sequence><Sequence from={sec(13, fps)} durationInFrames={sec(10, fps)}><ValidationScene /></Sequence><Sequence from={sec(23, fps)} durationInFrames={sec(6, fps)}><FailClosedScene config={config} /></Sequence><Sequence from={sec(29, fps)} durationInFrames={sec(9, fps)}><DoctorScene config={config} /></Sequence><Sequence from={sec(38, fps)} durationInFrames={sec(7, fps)}><EvidenceScene config={config} /></Sequence>{config.showCaptions ? <CaptionLayer /> : null}<OptionalVoiceover voiceoverPath={config.voiceoverPath} /></AbsoluteFill>;
};
