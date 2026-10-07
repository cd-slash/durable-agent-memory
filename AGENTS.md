# Mandatory billing safety on every change

Cloudflare Workers Paid is active. The owner requires extreme caution about billable usage.

For **every change**, including documentation/config/dependencies and tests, read and apply [.agents/skills/billing-safety/SKILL.md](.agents/skills/billing-safety/SKILL.md), consult [.agents/memory/BILLING.md](.agents/memory/BILLING.md), and add a new billing review under `.agents/billing-reviews/`. Run `npm run billing:check` and the relevant local checks before commit/deploy. CI requires a new review in every pushed change range. Do not claim that a checklist proves the absence of risk.

Never bypass the singleton billing guard, enable unbounded retry/recovery/alarm loops, or add unaudited providers/model prices. Do not increase quotas, remove guards, reset usage, or deploy an older unguarded version without explicit owner authorization. Resume billable work only under the owner's existing task authorization; the emergency switch itself always requires an explicit confirmation. Live tests must be finite, account for their reserved usage, and stop on any billing denial. Prefer local fixtures; do not run paid hosted tests in CI or on a schedule.

Default deployment is now the **guarded execution configuration** (`wrangler.execution.jsonc`). Both configs must retain the billing binding/migration, CPU ceiling and reviewed quotas. Keep memory writes append-only and preserve the Pi prompt-prefix invariant.

Emergency stop: authenticated `/admin/billing/stop` or the prominent red button on the demo home page. If the Worker is unreachable or requests are abusive, disable the public workers.dev endpoint using `npm run billing:disable-endpoint` with existing Cloudflare authentication. See [docs/BILLING.md](docs/BILLING.md) for residual costs, stop/resume instructions and current defaults.
