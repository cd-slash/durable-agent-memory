# Billing safety and emergency controls

Workers Paid is active. The owner requires a billing-risk review for **every change** and a reachable emergency stop. The persistent rule lives in [AGENTS.md](../AGENTS.md), [project memory](../.agents/memory/BILLING.md) and the [project skill](../.agents/skills/billing-safety/SKILL.md). Reviews live under `.agents/billing-reviews/`; `billing:check`, the installed project pre-commit hook and CI enforce a new assessment for each changed commit/push range. A review gate is not a proof of safety. Install the hook in new checkouts with `git config core.hooksPath .githooks`.

## Scope and current ceilings

The `BillingControl` SQLite Durable Object is a single coordinator for **the whole project**, across every agent/session. Atomic reservations happen before effects; new agent names cannot multiply quotas. Missing/unreachable control fails closed. Attempts, failed calls, retries and cancellations receive no refunds. UTC period rollover does not clear an emergency/quota stop.

| Resource | Per UTC day | Per UTC month |
|---|---:|---:|
| Authenticated API admissions | 500 | 5,000 |
| Submitted turns | 30 | 300 |
| AI attempts, including summaries/embeddings | 100 | 1,000 |
| Conservatively reserved AI neurons | 5,000 | 50,000 |
| Tool calls | 100 | 1,000 |
| JavaScript executions | 10 | 50 |
| Retained memory writes | 20 | 200 |
| Conservative storage reservations | 16 MiB | 128 MiB |

There are also lifetime ceilings of **50 agent objects** admitted through the gateway and **128 MiB of reserved storage**. Reservations deliberately overcount writes, including overwrites/deletes, model output and execution capability bytes; they are not measurements of live SQLite/VFS size. Existing pre-guard storage/objects are not retroactively measured. These lifetime ceilings require deliberate owner review before increasing them. Resume never resets counters or bypasses exhausted limits.

AI inputs are limited to 32 KiB serialized JSON, with another 4,096 tokens reserved for overhead. Serialized UTF-8 bytes deliberately overcount typical text tokens. Reviewed model rates are rounded upward: GLM input/output 0.006/0.04 neurons per reserved token, BGE input 0.007. Output is clamped to 1,024 tokens and thinking disabled. Unknown models and oversized context fail before inference; intentional reset/rollover may be needed for long conversations. Estimates are not authoritative Cloudflare metering.

Sources checked 2026-10-07: [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [GLM model](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/), [BGE model](https://developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5/). Workers AI currently has a shared free 10,000-neuron daily allocation; Workers Paid allows paid overages. This project stays below half that daily allocation **by its estimate**, leaving headroom, but other account workloads and pricing changes can consume it. Workers Paid does not make Workers AI or all other Cloudflare services free. Check the dashboard's actual usage separately.

Worker CPU is capped at 50ms per request; Dynamic Worker execution defaults to 3 seconds with one concurrent execution per agent, bounded capability calls, 128 KiB total capability traffic, 8 KiB result and 4 KiB stdio. Direct file mutations cap input at 64 KiB; model-visible page text is 4,000 characters. Logs are sampled at 10%; preview URLs are disabled. SSE observers stop after 120 seconds. Pi automatic retry and auto-compaction are disabled. Memory jobs execute one batch of at most four work units per enqueue with no periodic retry, recovery loop or startup auto-drain; explicit compaction uses at most eight units. Missing work remains durable for later deliberate processing. Existing alarms may wake once and return after stop.

## Emergency stop

Open the [demo home page](https://durable-agent-memory.cloudflare-henry.workers.dev), enter the existing private API token, and click the red **EMERGENCY STOP** button. It controls every agent, not just the selected one. No confirmation is needed to stop. Status and resume controls remain available while quotas are exhausted.

Or use the CLI with the existing private token file (never put credentials in command arguments):

```bash
BRIDGE_TOKEN_FILE=/home/coder/.config/durable-agent-memory/demo-token npm run billing:status
BRIDGE_TOKEN_FILE=/home/coder/.config/durable-agent-memory/demo-token npm run billing:stop
```

Equivalent authenticated HTTP paths are GET `/admin/billing/status`, POST `/admin/billing/stop`, and POST `/admin/billing/resume`. Stop latches SQLite state first, blocks new agent admissions, provider attempts, tool calls and summary processing, then requests bounded best-effort cancellation for up to 300 registered recent sessions, five at a time. It persists after redeployment, restart, midnight and month change. It is not rollback: an in-flight inference/execution may finish, incurred usage remains, and files/memory/transcripts are retained. Cancelling a run can discard a partial assistant response; retained data is not deleted.

Resume requires an explicit confirmation:

```bash
BRIDGE_TOKEN_FILE=/home/coder/.config/durable-agent-memory/demo-token npm run billing:resume -- --confirm-resume
```

The UI also asks for confirmation. Resume preserves quota usage. An exhausted daily/monthly/lifetime limit will immediately trip again on further work; inspect status and fix the cause first. Never clear the ledger to make a test pass. Limits cannot be raised from the browser.

## Out-of-band endpoint shutoff

If the Worker is unreachable or incoming requests are the problem, use the existing Cloudflare API token from the environment or configured `/home/coder/.env`:

```bash
npm run billing:disable-endpoint -- --dry-run
npm run billing:disable-endpoint -- --confirm-disable
```

The script makes at most three administrative API calls, disables both workers.dev and preview URLs and verifies the result. It does not print credentials or store them in the Worker. If token access is unavailable, disable the Worker routes in the authenticated Cloudflare dashboard. The script is specific to this account/project and only disables workers.dev/preview routes. **Any custom domains/routes added later need separate removal.** Latch the application stop first whenever reachable. API route settings changes can take time to propagate.

Do not redeploy/reopen endpoints or resume after an incident without explicit owner authorization. A Wrangler deployment may re-enable workers.dev according to its configuration. Endpoint disable is not account shutdown: active tasks, DO storage, custom routes and other resources may still be billable. No billing credential is exposed through the UI or agent tools.

## Change and deployment workflow

1. Read the project skill and operating memory. Trace affected requests, AI, DO storage/duration, tools, alarms, retries, logging and test automation.
2. Write a new review with the fields enforced by `scripts/billing-review.ts`, including worst-case counts, stop availability, validation and residual risk. Run `npm run billing:check` and relevant local tests.
3. Review limits and unknown-provider deny behavior. Do not raise budgets, reset usage, add paid infrastructure, bypass guards or roll back to an unguarded version without explicit owner approval.
4. Deploy the guarded execution config (`npm run deploy`). Both configurations preserve the global billing binding/migration. Inspect status before/after a finite hosted check; stop at the first denial. Hosted checks are never run automatically in CI or on a schedule.

The initial hosted execution smoke is bounded to three turns; it must fit within the remaining ledger. A stop/resume exercise uses the explicit existing task authorization for validation, restores only the prior operating state, and does not reset quotas. Normal operation has no dashboard polling loop; inspect usage manually.

## Limits of the protection

This is an application circuit breaker, **not a guaranteed account-wide dollar cap**. Cloudflare still meters incoming HTTP requests even when this app returns 401/503, and serves the static UI/health endpoint outside the coordinator. Coordinator checks, best-effort cancellations, storage retention, in-flight work, scheduled wakeups and other account services can still incur costs. Attack traffic must be handled with Cloudflare edge controls/endpoint disable. Use provider billing alerts, monitor actual account usage, and separately review all other services. Absolute avoidance of every possible overage cannot be enforced solely by this Worker.


## Latest deployment verification

The guarded execution deployment succeeded on 2026-10-07. All 37 unit tests and local workspace/stop/object-quota, restart and bridge suites passed. Hosted authentication/stop/denial/resume tests passed with zero new AI reservations. A subsequent bounded hosted execution smoke failed to find its expected file on the next turn; the model had made several attempts. The global stop was then latched rather than retrying. At stop the ledger showed 1649 reserved neurons, 12 AI attempts, 6 executions and 2 turns. These are estimated reservations, not an invoice. The agent is intentionally stopped pending diagnosis; stop/status controls remain available. Do not infer successful hosted file persistence from local tests alone.
