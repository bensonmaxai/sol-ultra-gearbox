# Sol Ultra Gearbox launch video

Standalone 1080x1920 Remotion production package. It renders polished HTML/SVG fallback scenes even when `public/generated/`, `public/xai/`, and `public/voice/` are empty. To opt into a supplied enhancement, set the matching scene media `enabled` flag in the composition props and place the asset under `public/`.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run studio
npm run render:still
npm run render:bilingual
npm run render:clean
npm run copy:social
```

Both MP4 commands use H.264 with `yuv420p`. `copy:social` copies the bilingual and clean MP4s, cover PNG, both SRT files, and approved Traditional Chinese copy to `outputs/social/sol-ultra-gearbox-launch/`. It intentionally fails until the three rendered artifacts exist.

`npm run xai:dry-run` prints the three image-to-video commands only; it does not call xAI or create a billable job. The safe VHS tape is `tapes/doctor-dry-run.tape`; it records only `doctor` and the non-mutating apply dry-run through a deliberately reduced jq summary. It never runs the paid smoke command.
