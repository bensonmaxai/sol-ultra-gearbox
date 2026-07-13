import { Composition } from "remotion";
import { LaunchVideo } from "./LaunchVideo";
import { launchVideoConfig } from "./data/config";

export const RemotionRoot = () => <Composition id="GearboxLaunchVertical" component={LaunchVideo} durationInFrames={1350} fps={30} width={1080} height={1920} defaultProps={launchVideoConfig} />;
