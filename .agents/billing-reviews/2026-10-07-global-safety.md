## Change

Install project-wide durable quotas, AI reservations, persistent stop and endpoint-shutoff controls, bounded background jobs, review skill/memory and per-change CI/hook checks. Enable hosted execution only after local safety validation.

## Billable paths

Worker requests; shared coordinator and agent DO requests/duration/SQLite; all Pi model attempts, embeddings and summaries; tools including Dynamic Workers execution and VFS writes; SSE lifetime; background alarms; logging; finite local/hosted checks. Endpoint shutoff uses three bounded Cloudflare administrative API calls and no model calls.

## Worst-case bounds

Global 500 requests/30 turns/100 AI attempts/100 tool calls/10 executions/20 retained writes per UTC day; monthly 5000/300/1000/1000/50/200 respectively. Estimated AI reservations capped at 5000 neurons/day and 50000/month; 32768 serialized input bytes plus overhead, 1024 output tokens, reviewed model allowlist. Every provider attempt reserves before inference; no refunds. Worker CPU 50ms, execution default 3 seconds, one concurrent execution per DO, 8KiB results/4KiB stdio, 64KiB direct writes, 128KiB capability byte cap per exec. Lifetime limits of 50 admitted agent objects and 128MiB conservative storage reservations, with 16MiB/day and 128MiB/month ceilings. Memory writes capped at 16KiB; bounded summary batches. Stop cancellation fanout is at most 300 registered objects in batches of five. These are application bounds, not an account-wide invoice guarantee.

## Failure and retry

AI retry disabled, automatic context compaction disabled, summary recoveryLoop disabled, no recurring summary reschedule or startup auto-drain. AI/control failure denies further work. Quota trip latches stop until explicit resume, even across midnight/month rollover. Failed reservations are atomic and successful reservations never refunded. SSE observers have a 120-second ceiling. An already-scheduled alarm can wake once and return when stopped.

## Emergency stop

Authenticated global API and red home-page button latch first, then request bounded best-effort aborts. Stop/resume status bypasses quota gates so exhausted limits cannot hide controls. Resume requires confirmation and preserves usage. Out-of-band script disables workers.dev and previews through existing authentication if app is unreachable. Existing tasks, custom routes, storage and ingress remain residual risks.

## Validation

Unit checks cover durable/atomic daily/monthly ledger enforcement, persistent stop and explicit resume, unknown/oversized provider rejection, output clamp and failed-attempt reservation. Local workerd suite verifies execution/file isolation and emergency control authentication, denial, restart survival and data retention. Typecheck, bundle, persistence and bridge regressions run locally; CI is local-only. Hosted validation will be finite: at most three turns for workspace smoke plus one stop/resume exercise, with usage inspected before/after; stop on first denial. Local outcomes: 37 unit tests, typecheck and paid-config bundle passed; workerd execution/stop/object-quota suite, persistence suite and bridge suite passed. Skill validation passed. The out-of-band endpoint control performed one authenticated read-only dry run successfully. Hosted outcomes will be recorded in a subsequent verification review.

## Residual risks

Cloudflare account limits are shared and pricing can change. Byte-based reservations intentionally overcount typical text but are estimates, not authoritative metering. Unauthorized incoming traffic, static page traffic, DO/control overhead, storage retention, in-flight work and other account resources can still incur charges outside this guard. Shared demo auth needs tenant hardening. External route disabling must be checked for custom routes if those are added. Do not increase limits or deploy an unguarded rollback without explicit owner approval.
