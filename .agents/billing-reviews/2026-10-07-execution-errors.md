## Change

Correct JavaScript execution documentation and mark nonzero exit codes as Pi tool errors with valid recovery guidance. Add a durable four-model-request ceiling per admitted turn using official GenerationTask/LiveDoc APIs to identify the admitted turn, enforced at the provider boundary without changing request messages. Correct model guidance about unverified file effects.

## Billable paths

The existing WorkerLoader/AI/tool path remains behind unchanged global quotas. The hook prepares a stable admitted-input key; the provider boundary consumes it and reserves a durable per-turn counter before every model request, including recovery; it stores one small row per admitted input, already bounded by turn/object quotas. Read-only diagnostics observed invalid source and object exports, not successful file writes.

## Worst-case bounds

At most four model request attempts per admitted turn across changing generation IDs; no automatic retry or refunds. Global 5000 estimated neurons/day, 10 executions/day and all monthly/lifetime limits remain unchanged. Execution output remains 8KiB plus short fixed error guidance. One later hosted smoke can submit at most three new prompts, each bounded by four request attempts, with no quota reset. Existing usage is preserved.

## Failure and retry

Invalid syntax and runtime exitCode!=0 are errors, not success. Recovery feedback instructs valid default-function source and prohibits unchanged retry or unsupported success claims. Per-turn excess fails before provider inference; next turn is separately admitted under unchanged global limits. Hosted first failure causes stop and ends verification; no repeated paid smoke.

## Emergency stop

Stop remains active during local validation/deployment and diagnostics. The owner has explicitly authorized continuing the build. One explicit resume for finite verification is allowed under that authorization; stop is requested on failure and usage is never cleared. Existing stop UI/API/CLI and out-of-band control are retained.

## Validation

Unit tests verify error propagation/evidence preservation and durable per-turn accounting. Official Pi integration tests will verify the hook counts through tool rounds and recovery without altering the historical prefix. Local workerd suite will verify runtime execution errors are visible and persistence still works. Completed: npm run check passed (42 tests, typecheck and guarded deployment dry-run). Local workerd workspace and recovery suites passed, including actual sandbox file persistence across restart. Bridge suite passed when rerun sequentially after a local workerd inspector-port collision. The hosted assertion now checks exitCode=0 and returned computation, then successful file-read contents rather than merely scanning command text. No hosted inference has run during diagnosis.

## Residual risks

Model source generation is probabilistic; clearer tools cannot guarantee a correct program or honest interpretation every time. Per-turn and global limits bound attempts. No authoritative billing guarantee is claimed, and no real user transcript is committed.
