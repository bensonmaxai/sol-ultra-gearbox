export type CaptionPair = {
  startMs: number;
  endMs: number;
  en: string;
  zhTW: string;
};

export type SceneMedia = {
  enabled: boolean;
  generatedBackground: string;
  videoEnabled: boolean;
  xaiClip?: string;
};

export type DoctorMedia = {
  enabled: boolean;
  recordingPath: string;
  playbackRate: number;
};

export type LaunchVideoConfig = {
  githubUrl: string;
  voiceoverPath?: string;
  showCaptions: boolean;
  media: {
    routing: SceneMedia;
    failClosed: SceneMedia;
    rollback: SceneMedia;
    doctor: DoctorMedia;
  };
};
