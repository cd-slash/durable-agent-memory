import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = process.env.BRIDGE_REMOTE_URL ?? 'https://durable-agent-memory.cloudflare-henry.workers.dev';
const tokenFile = process.env.BRIDGE_TOKEN_FILE;
if (!base.startsWith('https://') || !tokenFile) throw new Error('Set HTTPS BRIDGE_REMOTE_URL and private BRIDGE_TOKEN_FILE');
const token = (await readFile(tokenFile, 'utf8')).trim();
async function control(action: string, body?: unknown) {
  const res = await fetch(`${base}/admin/billing/${action}`, { method: action === 'status' ? 'GET' : 'POST', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() as any };
}
const before = await control('status'); assert.equal(before.status, 200);
assert.equal(before.data.stopped, false, 'Do not resume an owner-stopped system to make a test pass');
const unauthorized = await fetch(`${base}/admin/billing/stop`, { method: 'POST', signal: AbortSignal.timeout(15000) });
assert.equal(unauthorized.status, 401);
assert.equal((await control('stop')).data.stopped, true);
const denied = await fetch(`${base}/api/billing-smoke-${Date.now()}/chat`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'This must be denied before model inference', operationId: crypto.randomUUID() }) });
assert.equal(denied.status, 503);
const stopped = await control('status'); assert.deepEqual(stopped.data.reservations, before.data.reservations, 'Denied work must not call inference or consume reservations');
assert.equal((await control('resume', { confirm: 'wrong' })).status, 400);
assert.equal((await control('status')).data.stopped, true);
assert.equal((await control('resume', { confirm: 'RESUME BILLABLE WORK' })).data.stopped, false);
const after = await control('status'); assert.deepEqual(after.data.reservations, before.data.reservations, 'Resume must not reset prior usage');
const html = await (await fetch(base, { signal: AbortSignal.timeout(15000) })).text(); assert.match(html, /id="billing-stop"/);
console.log('PASS: hosted authenticated emergency stop denies new work before inference, requires explicit resume, preserves usage, and has a visible home-page control. Zero new AI reservations.');
