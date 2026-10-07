## Change

Continue the owner's build after explicit authorization. Add bounded authenticated read-only diagnostics while stopped, inspect the failed hosted execution, correct its cause, and validate locally before one bounded hosted verification.

## Billable paths

Administrative session/inspection reads use existing known agent objects and the billing coordinator. No AI or execution is launched by diagnostics; the persistent global stop remains active. Later hosted validation remains subject to unchanged project quotas, with usage inspected first and no counter reset.

## Worst-case bounds

Session listing is capped at 50 registered names; inspection requires a known name and returns at most 12 recent tool results/calls with bounded text. Diagnostics do not permit arbitrary agent creation. One hosted verification, once a tested fix exists, uses at most three prompts and must stop at first error/denial. No automatic retry or paid CI.

## Failure and retry

Stop remains latched throughout diagnosis. Failed diagnostics are not retried in a loop. The owner explicitly authorized continuing; a later explicit test resume will retain all prior usage and be followed by a stop on failure. Quotas, CPU ceilings and provider allowlist are not increased.

## Emergency stop

UI/API/CLI stop remains independent of work admission. Read-only diagnosis remains available while stopped; only existing registered objects can be inspected. Endpoint shutoff remains available if the app cannot respond.

## Validation

Local tests will exercise diagnostic authentication, known-object filtering, bounded output and stop preservation. Runtime/library and tool traces will distinguish program errors from platform persistence failure before any paid model retry. Results will be recorded after verification.

## Residual risks

Administrative reads/control overhead are billable requests; application controls remain estimates and not an account-wide cap. No transcript/secret is committed. Hosted models may generate invalid programs; execution errors must be communicated honestly and bounded.
