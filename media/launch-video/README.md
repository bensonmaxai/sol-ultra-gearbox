# Sol Ultra Gearbox launch video

Standalone 1080x1920 Remotion production package. The code-native terminal remains the Doctor-scene fallback; generated scene backgrounds are staged under `public/generated/` and xAI clips under `public/xai/`.

## Remotion license

This package declares Remotion's public `free-license` key. The dated basis,
official sources, owner headcount attestation, and re-review triggers are in
`REMOTION_LICENSE_REVIEW.md`. Re-check eligibility before release if the team
using Remotion grows to 4 people or more or the applicable terms change.

## Prepare supplied media

Before enabling a full render, place the three owner-approved PNGs at:

```text
public/generated/routing-background.png
public/generated/fail-closed-background.png
public/generated/rollback-background.png
```

The committed launch configuration also expects these ignored local inputs:

```text
public/xai/gear-routing.mp4
public/xai/fail-closed-gate.mp4
public/xai/rollback-clean-state.mp4
public/voice/narration.wav
public/generated/doctor-dry-run.mp4
```

Generate the narration locally through `local-voice/README.md`; the authorized
reference clip, profile, model cache, and rendered WAV stay outside Git. The
three xAI MP4s remain billable external outputs and are never reconstructed by
tests. Their post-run integrity is captured by the sanitized evidence workflow
described below.

The reproducible still-image requests are under `prompts/keyframes/`. They are separate from the motion-only xAI requests under `prompts/xai/`.

The English one-page campaign prompt is `prompts/one-page-en-v1.txt`. Its raster
output is a generated delivery artifact and remains ignored.

The three approved background images and xAI clips are enabled in the committed launch configuration. A reproducible clone must place all three ignored MP4s under `public/xai/` before rendering. Set a scene's `videoEnabled` flag to `false` when that clip is intentionally unavailable.

The committed configuration uses the actual VHS capture during 29–38s. Run `npm run record:doctor` to create `public/generated/doctor-dry-run.mp4`; its deterministic `playbackRate: 3` fits both command PASS summaries inside the nine-second Doctor scene. If the recording is intentionally unavailable, set `media.doctor.enabled` to `false` to use the code-native fallback.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run studio
npm run record:doctor
npm run render:still
npm run render:bilingual
npm run render:clean
npm run xai:evidence
npm run copy:social
```

Both MP4 commands use H.264 with `yuv420p`. `copy:social` copies the bilingual and clean MP4s, cover PNG, both SRT files, and approved Traditional Chinese copy to `outputs/social/sol-ultra-gearbox-launch/`. It intentionally fails until the three rendered artifacts exist.

`npm run xai:dry-run` runs three real local validations through the xAI helper with `--dry-run`; it does not call xAI or create a billable job. It uses `XAI_VIDEO_SCRIPT` when supplied, otherwise resolves the helper below `${CODEX_HOME:-$HOME/.codex}`. Live image-to-video generation is billable and still requires explicit owner authorization; no automatic retry is configured.

After authorized clips are downloaded, keep the provider manifests under the ignored `receipts/` folder and run `npm run xai:evidence`. The command binds each local MP4 to its receipt with bytes and SHA-256, probes its primary video stream, and writes the tracked `manifests/xai-generation-evidence.json`. Raw request IDs stay local; the public manifest contains only their SHA-256 digests and never stores signed output URLs. `copy:social` includes this sanitized manifest in the ignored delivery folder.

The safe VHS tape is `tapes/doctor-dry-run.tape`; `npm run record:doctor` starts VHS from the repository root and writes `public/generated/doctor-dry-run.mp4`. Dedicated jq gates emit unique PASS sentinels only when every required value matches; missing or false fields stop the tape. The tested VHS 0.11.0 Bash profile uses `--noprofile`, `--norc`, disabled history, and a fixed `>` prompt, but the rendered frames must still be checked for private paths, username, and hostname before publication. The tape never runs the paid smoke command. On macOS installations where ttyd starts more slowly than VHS 0.11.0 expects, use a VHS build with a ttyd-readiness wait; the tape itself is unchanged.
