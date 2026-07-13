import type { Caption } from "@remotion/captions";
import captionPairsJson from "./captions.json";
import type { CaptionPair } from "../types";

export const captionPairs = captionPairsJson as CaptionPair[];

export const englishCaptions: Caption[] = captionPairs.map((caption) => ({
  text: caption.en,
  startMs: caption.startMs,
  endMs: caption.endMs,
  timestampMs: null,
  confidence: null,
}));
