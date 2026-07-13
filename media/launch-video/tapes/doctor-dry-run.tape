Output media/launch-video/public/generated/doctor-dry-run.mp4
Set Shell "bash"
Set FontSize 28
Set TypingSpeed 1ms
Set Width 1000
Set Height 1000

Type "npm run --silent doctor -- --json | jq -c -f media/launch-video/tapes/jq/doctor-pass.jq"
Enter
Wait+Screen /GEARBOX_DOCTOR_PASS/
Sleep 1500ms
Type "node scripts/gearbox.mjs apply --promote-v2 --dry-run | jq -c -f media/launch-video/tapes/jq/apply-dry-run-pass.jq"
Enter
Wait+Screen /GEARBOX_DRY_RUN_PASS/
Sleep 1500ms
