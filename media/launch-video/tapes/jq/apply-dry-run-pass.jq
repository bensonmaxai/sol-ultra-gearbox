if (
  .pass == true and
  (.changes.config.changed | type) == "boolean" and
  (.changes.agents.changed | type) == "boolean" and
  .changes.installedRoleCount == 6 and
  .changes.secretsCopiedToReport == false
)
then
  {
    pass: .pass,
    configChanged: .changes.config.changed,
    agentsChanged: .changes.agents.changed,
    roleCount: .changes.installedRoleCount,
    secretsCopiedToReport: .changes.secretsCopiedToReport
  },
  ("GEARBOX" + "_" + "DRY" + "_" + "RUN" + "_" + "PASS")
else
  error("dry-run verification failed")
end
