---
name: billing-safety
description: Review every change in this Cloudflare Workers Paid project for runaway billing, retain durable global limits and emergency controls, and perform bounded validation/deployment. Includes code, configuration, dependency and documentation changes.
---

Read `AGENTS.md`, `.agents/memory/BILLING.md` and `docs/BILLING.md` from the repository root. The owner explicitly requires this review for every change.

1. Trace all billable paths touched or indirectly affected: HTTP/SSE admission, DO creation and duration, AI input/output/model rates, compaction/embeddings, tool/execution limits, storage, telemetry, retries, alarms, recovery and deployment/CI scripts.
2. Identify worst-case multiplication and duration. Check the single global guard, atomic reservations before effects, unknown-provider denial, finite failure/retry paths, persistent stop, and no auto-resume at day/month rollover. Keep count/token/CPU/storage assumptions distinct from guarantees about Cloudflare invoices.
3. Use local fixtures first. For a hosted check, write down its finite maximum calls/turns/executions and inspect usage before/after. Stop on any denial; do not retry repeatedly or reset counters to make tests pass. Never run live paid smoke checks automatically in CI or a scheduler.
4. Test the controls relevant to the change, including stop/resume availability if routing/auth changes. Record evidence and remaining risks in a **new** `.agents/billing-reviews/<unique-name>.md` using the fields checked by `scripts/billing-review.ts`. Documentation-only changes still need an explicit risk assessment, not new runtime tests.
5. Run `npm run billing:check`, relevant checks, and inspect the diff. Before deploying, preserve the guarded configuration/migrations and stop control. Never roll back to a build without these controls. Quota increases, guard removal, usage reset and new paid infrastructure require explicit owner approval; quote the relevant owner requirement when approval is needed.

Emergency: POST `/admin/billing/stop` using the existing private token file, or click the demo's red button. This latches the global gate first and requests bounded best-effort cancellation. If HTTP traffic itself is the problem or the app cannot respond, disable the workers.dev endpoint via the documented out-of-band control. Pause work until the owner explicitly requests resumption. Keep secrets out of command arguments, logs, reviews and committed files.
