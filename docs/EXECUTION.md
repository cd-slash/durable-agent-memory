# Hosted execution capabilities

The T3 Pi bridge connects to the real hosted PiHarness. Workers Paid is now active. Hosted execution uses the guarded configuration with global quotas and an emergency stop. See [BILLING.md](BILLING.md) before deployment or live tests.

The model tools are:

- `read`, `write`, `edit`, `delete`, `ls`, `find`, `grep`: private durable virtual files.
- `exec` (optional paid configuration): JavaScript ES module source in a fresh Cloudflare Worker isolate.
- `web_fetch`: bounded HTTPS page reading on an exact host allowlist.
- `remember`, `recall`, `memory_expand`: retained long-term memory, separate from files and the transcript.

With execution enabled, try asking: “Use exec to sum the squares from 1 to 100. Write the result to /workspace/result.json.” Then ask in another turn: “Read that file and explain the calculation.” Files survive Worker restart and remain isolated by agent/DO. A new T3 session uses a different workspace. Deploying this capability upgrade changes static tool instructions once; ordinary writes do not change the established prefix.

Example `exec.command`:

```js
import { writeFile } from 'node:fs/promises';
export default async function () {
  const total = Array.from({length: 100}, (_, i) => (i + 1) ** 2).reduce((a, b) => a + b, 0);
  await writeFile('/workspace/result.json', JSON.stringify({total}));
  return {total};
}
```

There is no Linux shell, Python, package installation, arbitrary network from execution, or access to the T3 machine’s checkout. Workspace files are not automatically Git-synchronized. General web search is not enabled: no search-provider credential was configured. Every tool/provider attempt is subject to the global billing stop and quotas; see BILLING.md. Page fetching defaults to `developers.cloudflare.com`, `github.com`, `raw.githubusercontent.com`, `en.wikipedia.org`. Administrators can set `WEB_ALLOWED_HOSTS` to a comma-separated list of vetted public hostnames. It replaces the default list. Do not configure internal/private hosts or treat website text as instructions.

All API/tool entry points retain the existing bearer authentication. Execution receives no host environment or Cloudflare credentials. Maximum source/input is 32 KiB, result 8 KiB, stdio 4 KiB, capability requests/responses 64 KiB, total capability bytes 128 KiB, 100 capability calls, one concurrent execution and a 3-second default execution deadline (backend maximum 10 seconds). Direct file writes/edits are capped at 64 KiB. Global call/estimated-neuron/storage quotas also apply; see BILLING.md. Interrupted effectful calls are not automatically replayed and may have already changed files.

`GET /api/<agent>/debug` reports execution mode, workspace root and web capability hosts along with the transcript/tool results. It requires the same token. Use file tools for workspace inspection.

## Enable hosted execution

Enable [Workers Paid](https://dash.cloudflare.com/efceafa29432e7f5d5fc86703f78d81b/workers/plans) in your account, then use existing authenticated CLI credentials:

```bash
npm run deploy:execution
```

This uses `wrangler.execution.jsonc`, which has the same Worker/DO/migrations and the additional Worker Loader binding. Existing data is retained. No new secret is required. Keep the two deployment configurations aligned when changing runtime settings. `npm run deploy` now uses the guarded execution configuration; both configs retain billing controls. To run the sandbox locally:

```bash
npm run dev -- --config wrangler.execution.jsonc --local --var LOCAL_TEST:true --var DEMO_TOKEN:local-testing-only
```

The local scripted model is a test fixture, not a general AI assistant. To verify real hosted models and tools after deployment:

```bash
BRIDGE_REMOTE_URL=https://your-worker.workers.dev \
BRIDGE_TOKEN_FILE=/path/to/private/token-file npm run test:hosted-workspace
```

The hosted smoke test detects enabled execution and uses real `exec` when available; otherwise it tests file writes/reads and web fetching without claiming execution.

## Validation and readiness

```bash
npm run check
npm run test:workspace
npm run test:recovery
npm run test:bridge
```

`test:workspace` uses the actual local WorkerLoader and Pi loop with an explicit scripted model. Hosted smoke checks use Workers AI separately; local fixtures are never installed in deployment.

This uses preview `@cloudflare/computer` 0.4.1 and beta Pi APIs. Dependency overrides pin patched `undici` and `guarded-fetch`. `npm audit` still reports a moderate `sprintf-js` precision denial-of-service advisory through the transitive `just-bash` dependency (and inherited package entries); there is no upstream patch at implementation time. The Bash backend is not configured or exposed. Do not force audit’s suggested downgrade to obsolete APIs. Production still needs tenant authorization instead of one shared demo token, measured billing/retained-storage hardening beyond conservative quotas, broader hosted failure testing, dependency hardening and a full sandbox/repository-sync design if shell development is required.


The 2026-10-07 guarded hosted verification passed after fixing model guidance and execution error reporting: actual JavaScript returned 338350 with exitCode 0, wrote JSON, and a subsequent turn successfully read its total and marker. A third turn fetched and cited a real public page. The service is enabled with the same quotas and emergency controls; each turn allows at most four model requests. See [billing verification](BILLING.md#latest-deployment-verification) for usage and restart-test boundaries. Nonzero exits are tool errors; do not claim successful writes without evidence or repeat unchanged failing source.
