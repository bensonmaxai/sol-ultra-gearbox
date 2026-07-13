export type CaptionPair = {
  startMs: number;
  endMs: number;
  en: string;
  zhTW: string;
};

export type SceneMedia = {
  enabled?: boolean;
  generatedBackground?: string;
  xaiClip?: string;
};

export type LaunchVideoConfig = {
  githubUrl: string;
  voiceoverPath?: string;
  showCaptions: boolean;
  media: {
    routing: SceneMedia;
    failClosed: SceneMedia;
    rollback: SceneMedia;
  };
};
