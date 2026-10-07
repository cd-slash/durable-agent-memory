## Change

Build project-scoped credentials, agent ownership, durable shared notes/tasks and explicit bounded task dispatch. Preserve the existing single-agent API for the owner. Connect the bridge and project UI to authorized agents.

## Billable paths

Project metadata is stored in the existing singleton SQLite coordinator, with storage reservations before writes. No new namespace, model, paid service or scheduler is introduced. Immutable per-agent tool policies deny effects before execution while keeping declarations stable; denied tool attempts still reserve one tool count. The two hosted test agents are restricted to team_board/team_note only, preventing accidental execution, memory writes or summary fan-out. Agent objects remain behind the lifetime global admission ceiling. Project task dispatch reserves turns before Pi submission; AI, embeddings and tools retain global and per-turn limits.

## Worst-case bounds

At most ten projects, eight credentials and four agents per project; at most 100 tasks and 100 notes per project, with bounded text. List reads cap outputs. Task dispatch is explicit, one task per request and at most two explicit dispatch attempts per stable operation, with no autonomous recursive fan-out or background polling. Existing daily/monthly/lifetime ceilings remain unchanged. New credentials cannot multiply quotas.

## Failure and retry

Task IDs and operation IDs are durable and idempotent. Concurrent task ownership uses SQLite transactions. A failed dispatch preserves the same operation ID for deliberate recovery; no automatic retry, alarm or rescheduling loop. Duplicate submissions conservatively reserve admissions, never refund effects. First hosted failure stops validation and latches emergency stop.

## Emergency stop

Owner credential revocation stays available while globally stopped: one bounded credential-row update, no namespace or inference, analogous to emergency administration and with residual SQLite/ingress cost. Owner-only global stop/status/resume remains available independent of project credentials and quotas. New project credentials cannot resume billable work. Existing out-of-band endpoint disable remains available. Stop must cancel all admitted active agents across projects.

## Validation

Use independent SQLite unit tests and local workerd scripted providers first. Verify token isolation/revocation, concurrent dispatch, per-agent transcript isolation, shared notes/tasks, restart persistence, owner-only stop and unchanged global limits before deployment. Local checks passed: 49 unit tests, typecheck, deployment dry-run, actual workerd multiplayer/workspace/recovery and T3 bridge suites. The UI script parses; a DOM integration check exercises local task dispatch/observation. Chromium rendering is unavailable because native libraries are missing. Current hosted ledger has 2683/5000 reserved neurons and no new AI calls from development. One finite hosted check is planned only with at least 2200 remaining estimated neurons: two tasks/turns, at most eight Pi requests plus two short query embeddings, zero executions, no memory summaries. It verifies editor/viewer permissions, a real agent handoff and another agent reading it. No repeats; first failure invokes global stop. Private demo credentials are stored outside git, never printed.

## Residual risks

Credential sharing grants the corresponding project role; this is scoped bearer access, not a complete user identity provider. Coordinator/ingress/storage remain billable even after stop. Metadata bounds and model limits do not guarantee an account-wide invoice cap. A general coding sandbox requires a separately chosen execution boundary; no new paid infrastructure is authorized by this change.
