Output media/launch-video/public/generated/doctor-dry-run.mp4
Set Shell "bash"
Set FontSize 28
Set TypingSpeed 1ms
Set Width 1000
Set Height 1000

Type "npm run --silent doctor -- --json | jq '{pass: .pass, roleCount: (.roleChecks | length)}'"
Enter
Wait+Screen /"roleCount": 6/
Sleep 1500ms
Type "node scripts/gearbox.mjs apply --promote-v2 --dry-run | jq '{pass: .pass, configChanged: .changes.config.changed, agentsChanged: .changes.agents.changed, roleCount: .changes.installedRoleCount, secretsCopiedToReport: .changes.secretsCopiedToReport}'"
Enter
Wait+Screen /"secretsCopiedToReport": false/
Sleep 1500ms
