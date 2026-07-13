Output public/generated/doctor-dry-run.mp4
Set Shell "bash"
Set FontSize 22
Set Width 1200
Set Height 700

Type "npm run --silent doctor -- --json | jq '{pass: .pass, roleCount: (.roleChecks | length), checks: .checks}'"
Enter
Sleep 3s
Type "node scripts/gearbox.mjs apply --promote-v2 --dry-run | jq '{pass: .pass, changes: {config: .changes.config.changed, agents: .changes.agents.changed, installedRoleCount: .changes.installedRoleCount, secretsCopiedToReport: .changes.secretsCopiedToReport}}'"
Enter
Sleep 3s
