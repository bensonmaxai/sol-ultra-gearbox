# Verified workflow orchestration

Use this contract for multi-stage work with dependencies, artifact handoffs,
approval facts, recovery, or resumable progress. Keep direct bounded work on
task packet schema version 1; do not manufacture a workflow for a single
self-contained action.

Gearbox implements an instruction-and-runner control, not a Codex core hook.
The supported execution shapes are `root_inline`, `typed_child`, and
`isolated_role_root`; `typed_child_bridge` stays disabled and
`app_thread_root` is not enabled.

## Plan contract

Accept only a validated DAG whose workflow and stage objects have exact fields.
Require declared dependencies, input and output artifacts, read/write scopes,
interfaces, attempt class, permissions, and safe approval facts. Reject cycles,
missing producers, unordered overlapping writers, undeclared artifacts, unsafe
paths, unknown adapters, and approval drift before scheduling.

Compile each stage into task packet schema version 2 so the handoff contains the
stage ID, dependency IDs, available inputs, required outputs, interfaces,
attempt class, and `block_and_report` missing-information policy. Keep every
packet self-contained; never pass parent conversation history as task state.

## Scheduling

Run the quality gate before the cost gate. Schedule at most two independent
readers or one exclusive writer in a round. The first real execution is the canary;
preserve reserved verification and recovery attempts so ordinary work cannot
consume them. Keep security decisions, side effects, approval decisions, and
final adjudication on the Sol root. Do not create an App-thread execution
shape.

## Materialization

Materialize only the first real execution in a batch. Require an exact
task-hash-bound running or completed receipt persisted in runtime evidence.
Release deferred work only after that receipt proves the intended provider and
typed identity. If the canary does not materialize, stop the batch, preserve
the deferred stages at attempt zero, and do not launch a second execution.

## Acceptance

Collect runtime identity, model, effort, sandbox, permission, lineage, scope,
descendant, token, artifact, and cleanup evidence. The lifecycle order is:

1. collect evidence;
2. mechanically verify hashes, scope, and runtime facts;
3. obtain explicit Sol adoption;
4. close the provider.

`verified` never means `adopted`. A dependent unlocks only after adoption, and
provider close never substitutes for verification. Reject missing metadata,
unexpected writes, undeclared artifacts, generic roles, descendants, or a
shape/task mismatch.

## Recovery

Treat a compatible upstream workflow store as the source of truth. Return
append-only events and outcomes to that store; never create a competing local
history. When no compatible upstream source exists, use exactly one private
managed hash-chain ledger.

Bind resume to the exact plan, policy, permission, workspace, and artifact
hashes. Resume adopted stages without rerunning them. Keep planned and ready
stages unconsumed. An incomplete materialization, running attempt, evidence
collection, or verification blocks recovery until the root resolves it; do not
guess completion or silently rematerialize it.

## Failure classes

- Plan or binding defect: fail closed before materialization; Sol repairs the
  plan or completes root-inline.
- Hard execution defect: stop delegation, reject the attempt, close owned
  resources, and use managed rollback when active global state changed. Do not
  retry with another model, role, permission, provider, or broader scope.
- Concrete local output defect: allow at most one correction with the same
  task identity, provider, role, permission, and scope; otherwise return to Sol.

## Evidence

Persist only safe hashes, booleans, counts, enums, attempt numbers, verified
model/effort identifiers, and token totals. Never persist raw goals, prompts,
tool output, private paths, session IDs, execution IDs, canonical task names,
or artifact contents.

The public deterministic contract requires five current scenarios and the Q10
first-real-execution canary. Do not publish performance, speed, savings, or
output-quality claims before ten comparable accepted root-inclusive pairs
exist; deterministic scenarios prove contract behavior, not production gains.
