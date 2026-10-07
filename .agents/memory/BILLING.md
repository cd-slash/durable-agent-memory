# Persistent project operating memory

Recorded 2026-10-07 from the owner's instruction: Workers Paid is active; be extremely careful about plan overages. Every future change must check for runaway billing and the project must have an emergency stop button. This policy is persistent and applies to all changes, not only billing-related code.

The guard is project-wide, not per-agent. New agent names must never multiply limits. All AI attempts (including summaries, embeddings, retries and recovery) reserve before contacting Workers AI. Effects/tools and turn/request admissions are bounded too. Reservations are conservative and not refunded after failure or cancellation. A stop/quota trip persists across restarts and date rollover until explicit resume; resume does not clear counters.

Workers Paid is not an account-wide spending cap. Workers AI has its own pricing/free daily allocation; other account resources and incoming requests can still be billed. Never promise guaranteed zero overages. No credentials belong in this repo or this memory. The model-facing long-term-memory store is not where this operating policy belongs.

Authoritative current limits and implementation: `src/billing/policy.ts`, `docs/BILLING.md`. Change workflow: `AGENTS.md`, `.agents/skills/billing-safety/SKILL.md`. Emergency stop: demo home page or authenticated POST `/admin/billing/stop`. Out-of-band endpoint shutoff is available if the app is inaccessible. Do not raise limits or roll back to an unguarded build without explicit owner approval.
