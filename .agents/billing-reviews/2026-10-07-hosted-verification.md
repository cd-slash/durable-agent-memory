## Change

Add a finite hosted emergency-control smoke script, verify the guarded paid deployment, and record operating evidence. No quota increases or new providers.

## Billable paths

Three hosted workspace turns (calculation/write, read, page fetch) and a finite control test: status, unauthorized stop, authenticated stop, one denied chat, wrong/right resume and static page inspection. Cloudflare admin endpoint checks are read-only. No hosted CI/scheduler work is added.

## Worst-case bounds

The smoke script sends at most three real prompts and one denied prompt. Provider/tool attempts remain bounded by the project-wide remaining daily/monthly/lifetime quotas. It stops on the first error or billing denial and uses finite HTTP deadlines; it does not replenish usage or repeat tests automatically. The control exercise submits no successful AI turn. All original 5000/day estimated-neuron and 10/day execution ceilings remain unchanged.

## Failure and retry

No automatic smoke retries. If the system is already stopped, the hosted control script exits before changing state. A test failure after stop leaves the gate latched for deliberate operator attention. Valid resume is exercised only after proving denied work and under the owner's existing authorization for validation. No counter reset.

## Emergency stop

The deployed UI/API/CLI stop remains available. Out-of-band public-endpoint disable was checked read-only; it is not invoked here. In-flight work/cancellation effects remain best-effort and are documented.

## Validation

Guarded deployment d5100049-940f-4654-82ff-ee8554bdf42e succeeded with BILLING and LOADER bindings. Local 37 unit tests, typecheck, execution bundle, workspace/stop/object-quota suite, persistence and bridge suites passed; project skill validation passed. Hosted emergency-control test passed: authenticated stop denied new work before inference, wrong resume confirmation failed, explicit resume preserved zero initial usage, and the home page exposed the control. The execution smoke failed on its second turn: calculation returned a result but the expected file was missing; no third prompt was sent and no automatic retry was performed. The operator latched emergency stop. Reservations after this bounded test: 12 AI attempts, 6 executions, 8 tool calls, 2 turns, 1649 estimated neurons and 3634000 conservative storage bytes. Out-of-band post-deploy read-only check confirmed workers.dev enabled and preview URLs disabled. The final operating state is stopped; usage was not reset. The hosted script now prints its synthetic test-agent ID for future read-only diagnosis.

## Residual risks

Application reservations are conservative estimates, not account-wide invoice caps. Traffic/control requests and retained data can still be billed; other account workloads and pricing changes are outside this project ledger. The short global stop test can interrupt registered active agents. Do not silently resume an already-stopped environment or retry a failed smoke indefinitely.
