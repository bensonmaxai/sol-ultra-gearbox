import { Composition } from "remotion";
import { LaunchVideo } from "./LaunchVideo";

export const RemotionRoot = () => <Composition id="GearboxLaunchVertical" component={LaunchVideo} durationInFrames={1350} fps={30} width={1080} height={1920} defaultProps={{ githubUrl: "https://github.com/bensonmaxai/sol-ultra-gearbox", showCaptions: true, media: { routing: { enabled: false, generatedBackground: "generated/routing-background.png", xaiClip: "xai/gear-routing.mp4" }, failClosed: { enabled: false, generatedBackground: "generated/fail-closed-background.png", xaiClip: "xai/fail-closed-gate.mp4" }, rollback: { enabled: false, generatedBackground: "generated/rollback-background.png", xaiClip: "xai/rollback-clean-state.mp4" } } }} />;
