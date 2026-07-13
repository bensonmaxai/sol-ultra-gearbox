# Sol Ultra Gearbox launch video

Standalone 1080x1920 Remotion production package. The code-native terminal remains the Doctor-scene fallback; generated scene backgrounds are staged under `public/generated/` and xAI clips under `public/xai/`.

## Prepare supplied media

Before enabling a full render, place the three owner-approved PNGs at:

```text
public/generated/routing-background.png
public/generated/fail-closed-background.png
public/generated/rollback-background.png
```

The three background media settings are enabled by default. xAI clips stay disabled through each scene's `videoEnabled: false`, so a missing MP4 is never requested. After a clip has been generated and reviewed, set only that scene's `videoEnabled` flag to `true`.

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
npm run copy:social
```

Both MP4 commands use H.264 with `yuv420p`. `copy:social` copies the bilingual and clean MP4s, cover PNG, both SRT files, and approved Traditional Chinese copy to `outputs/social/sol-ultra-gearbox-launch/`. It intentionally fails until the three rendered artifacts exist.

`npm run xai:dry-run` runs three real local validations through the xAI helper with `--dry-run`; it does not call xAI or create a billable job. It uses `XAI_VIDEO_SCRIPT` when supplied, otherwise resolves the helper below `${CODEX_HOME:-$HOME/.codex}`. Live image-to-video generation is billable and still requires explicit owner authorization; no automatic retry is configured.

The safe VHS tape is `tapes/doctor-dry-run.tape`; `npm run record:doctor` starts VHS from the repository root and writes `public/generated/doctor-dry-run.mp4`. It advances only after seeing the expected six-role doctor result and the non-mutating apply dry-run result, both reduced through jq, and never runs the paid smoke command. On macOS installations where ttyd starts more slowly than VHS 0.11.0 expects, use a VHS build with a ttyd-readiness wait; the tape itself is unchanged.
