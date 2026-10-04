import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const port = 8791, token = 'local-recovery-only';
const base = `http://127.0.0.1:${port}`;
let proc: ReturnType<typeof spawn> | undefined;
let output = '';
async function start() {
  output = '';
  proc = spawn('node_modules/.bin/wrangler', ['dev', '--local', '--port', String(port), '--var', 'LOCAL_TEST:true', '--var', `DEMO_TOKEN:${token}`], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  proc.stdout!.on('data', chunk => { output += chunk; }); proc.stderr!.on('data', chunk => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    if (proc.exitCode !== null) throw new Error('Wrangler exited during startup');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Local Worker did not become healthy');
}
async function stop() {
  if (!proc || proc.exitCode !== null) return;
  const child = proc;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  process.kill(-child.pid!, 'SIGTERM');
  await exited;
  proc = undefined;
}
async function api(action: string, body?: unknown): Promise<any> {
  const response = await fetch(`${base}/api/local-recovery/${action}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${action} HTTP ${response.status}`); return response.json();
}
try {
  await start();
  await api('remember', { content: 'SQLite survives a workerd restart.', kind: 'preference', idempotencyKey: 'restart-memory' });
  await api('compact', {});
  const chat = await api('chat', { message: 'Recall SQLite', operationId: 'restart-chat' });
  assert.equal(chat.status, 'done');
  const before = await api('debug'); assert.ok(before.transcript.length > 0);
  await stop(); await start();
  const after = await api('debug');
  assert.deepEqual(after.events, before.events); assert.deepEqual(after.nodes, before.nodes); assert.deepEqual(after.transcript, before.transcript);
  const next = await api('chat', { message: 'SQLite after restart?', operationId: `restart-next-${Date.now()}` });
  assert.equal(next.status, 'done'); assert.ok(next.retrieval.text.includes('SQLite'));
  const response = await fetch(base + '/cdn-cgi/local/explorer/api/local/observability/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: "SELECT name,outcome FROM spans WHERE parent_id IS NULL AND outcome != 'ok' LIMIT 10" }) });
  if (response.ok) {
    const logs = await response.json();
    console.log('Local observability query:', JSON.stringify(logs));
  }
  assert.ok(!output.includes('hm_request_failed') && !output.includes('pi_report'), 'Runtime reported an error');
  console.log('PASS: real SQLite Durable Object + PiHarness transcript, events and nodes survive workerd restart. Local model is explicitly scripted.');
} finally { await stop(); }
