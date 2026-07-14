export function workflowPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowId: "verified-audit",
    goal: "Audit two modules, verify the evidence, then adopt the report",
    workflowAdapter: "superpowers:executing-plans",
    inputArtifacts: ["repository-snapshot"],
    attemptBudget: {
      total: 4,
      reservedForVerification: 1,
      reservedForRecovery: 1,
    },
    stages: [
      stage({
        id: "audit-core",
        outputArtifacts: ["core-evidence"],
        readScope: ["lib"],
      }),
      stage({
        id: "audit-cli",
        outputArtifacts: ["cli-evidence"],
        readScope: ["scripts"],
      }),
      stage({
        id: "verify-evidence",
        responsibility: "review",
        dependsOn: ["audit-core", "audit-cli"],
        attemptClass: "verification",
        inputArtifacts: ["core-evidence", "cli-evidence"],
        outputArtifacts: ["verified-report"],
        readScope: ["lib", "scripts", "tests"],
        requestedRole: "sol_reviewer",
      }),
    ],
    ...overrides,
  };
}

export function stage(overrides = {}) {
  return {
    id: "audit-stage",
    responsibility: "exploration",
    dependsOn: [],
    attemptClass: "work",
    inputArtifacts: ["repository-snapshot"],
    outputArtifacts: ["stage-evidence"],
    approvalGate: null,
    readScope: ["lib"],
    writeScope: [],
    interfaces: ["Return path, symbol, and evidence records"],
    knownFacts: ["The workspace is a fixture"],
    constraints: ["Read only"],
    deliverable: "Structured evidence",
    successCriteria: ["Every claim names a file and symbol"],
    checks: ["Confirm all declared inputs were inspected"],
    prohibitedActions: ["Do not spawn descendants"],
    parentPermission: "workspace-write",
    requiredPermission: "read-only",
    requestedRole: null,
    riskSignals: {
      ambiguous: false,
      hiddenCoupling: false,
      highRisk: false,
      weakVerification: false,
    },
    costSignals: {
      estimatedRootToolCalls: 5,
      oneLocation: false,
      packagingDominates: false,
      directlyConsumable: true,
      repetitiveReads: 0,
      moduleCount: 2,
      fileCount: 5,
      bytes: 0,
      lines: 0,
      itemCount: 0,
      includesRegressionTest: false,
      boundedFileCount: 0,
    },
    ...overrides,
  };
}
