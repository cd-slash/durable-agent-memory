import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const port = 8794, token = 'local-workspace-test';
const base = `http://127.0.0.1:${port}`;
const persistence = mkdtempSync(join(tmpdir(), 'hm-runtime-test-'));
let proc: ReturnType<typeof spawn> | undefined;
let output = '';
const agent = `workspace-test-${Date.now()}`;
async function start() {
  output = '';
  proc = spawn('node_modules/.bin/wrangler', ['dev', '--config', 'wrangler.execution.jsonc', '--local', '--persist-to', persistence, '--port', String(port), '--var', 'LOCAL_TEST:true', '--var', `DEMO_TOKEN:${token}`], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  proc.stdout!.on('data', c => output += c); proc.stderr!.on('data', c => output += c);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    if (proc.exitCode !== null) throw new Error('Wrangler startup failed');
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Worker startup timed out');
}
async function stop() {
  if (!proc || proc.exitCode !== null) return;
  const p = proc; const exited = new Promise<void>(r => p.once('exit', () => r()));
  process.kill(-p.pid!, 'SIGTERM'); await exited; proc = undefined;
}
async function api(path: string, body?: unknown, id = agent): Promise<any> {
  const res = await fetch(`${base}/api/${id}/${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(res.ok, `${path}: HTTP ${res.status}`); return res.json();
}
async function tool(name: string, args: Record<string, unknown>, id = agent) {
  const result = await api('chat', { message: `workspace-fixture:${JSON.stringify({ tool: name, args })}`, operationId: crypto.randomUUID() }, id);
  assert.equal(result.status, 'done');
  const { messages } = await api('rpc', { type: 'get_messages' }, id);
  const last = messages.filter((m: any) => m.role === 'toolResult').at(-1);
  assert.ok(last, JSON.stringify(messages));
  assert.equal(last.toolName, name);
  assert.equal(messages.at(-1).role, 'assistant', 'Model must continue after tool execution');
  return last;
}
try {
  await start();
  const page = await (await fetch(base)).text(); assert.match(page, /id="billing-stop"/);
  let result = await tool('exec', { command: 'export default () => ({answer: 6 * 7})', cwd: '/workspace' });
  assert.ok(!result.isError, JSON.stringify(result)); assert.match(JSON.stringify(result.content), /42/);
  result = await tool('exec', { command: "import {writeFile,readFile} from 'node:fs/promises'; export default async () => {await writeFile('/workspace/proof.txt','persistent-marker'); return await readFile('/workspace/proof.txt','utf8');}", cwd: '/workspace' });
  assert.ok(!result.isError, JSON.stringify(result)); assert.match(JSON.stringify(result.content), /persistent-marker/);
  const before = await api('debug');
  await stop(); await start();
  const after = await api('debug'); assert.notEqual(after.bootId, before.bootId); assert.deepEqual(after.transcript, before.transcript);
  result = await tool('read', { path: '/workspace/proof.txt' }); assert.ok(!result.isError); assert.match(JSON.stringify(result.content), /persistent-marker/);
  result = await tool('read', { path: '/workspace/proof.txt' }, `${agent}-isolated`); assert.ok(result.isError, 'Separate DO must not access another workspace');
  result = await tool('exec', { command: "export default () => ({hostEnv:typeof process, key:typeof CLOUDFLARE_API_TOKEN})", cwd: '/workspace' });
  assert.match(JSON.stringify(result.content), /undefined/);
  result = await tool('exec', { command: "import {readFile} from 'node:fs/promises'; export default () => readFile('/etc/passwd','utf8')", cwd: '/workspace' });
  assert.ok(result.isError, 'Nonzero JavaScript exits must be visible as tool errors');
  assert.match(JSON.stringify(result.content), /outside|escape|denied|error|must stay under/i);
  result = await tool('exec', { command: "export default async () => { try { await fetch('https://example.com'); return 'NETWORK_ALLOWED'; } catch { return 'NETWORK_BLOCKED'; } }", cwd: '/workspace' });
  assert.match(JSON.stringify(result.content), /NETWORK_BLOCKED/);
  const began = Date.now();
  result = await tool('exec', { command: 'export default async () => new Promise(() => {})', cwd: '/workspace' });
  assert.ok(Date.now() - began < 15000, 'Execution deadline must bound nonterminating code');
  assert.match(JSON.stringify(result.content), /timeout|timed out|deadline|exceed|error/i);
  result = await tool('exec', { command: 'export default () => 7', cwd: '/workspace' }); assert.match(JSON.stringify(result.content), /7/);
  const admin = async (action: string, body?: unknown) => {
    const res = await fetch(`${base}/admin/billing/${action}`, { method: action === 'status' ? 'GET' : 'POST', signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  assert.equal((await fetch(`${base}/admin/billing/stop`, { method: 'POST' })).status, 401);
  const usage = await admin('status'); assert.equal(usage.body.stopped, false);
  assert.ok(usage.body.reservations.some((r: any) => r.kind === 'executions' && r.used > 0));
  await api('submit', { message: 'slow bridge cancellation', operationId: crypto.randomUUID() });
  assert.equal((await admin('stop')).body.stopped, true);
  const sessions = await fetch(`${base}/admin/billing/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  assert.ok((await sessions.json() as any).sessions.some((s: any) => s.name === agent));
  const inspect = await fetch(`${base}/admin/billing/inspect?agent=${agent}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  assert.equal(inspect.status, 200); assert.ok((await inspect.json() as any).tools.length <= 12);
  const unknown = await fetch(`${base}/admin/billing/inspect?agent=never-created`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  assert.equal(unknown.status, 404); assert.equal((await admin('status')).body.stopped, true);

  const denied = await fetch(`${base}/api/${agent}/chat`, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Should be blocked' }) });
  assert.equal(denied.status, 503);
  await stop(); await start();
  assert.equal((await admin('status')).body.stopped, true, 'Emergency stop survives Worker restart');
  assert.equal((await admin('resume', { confirm: 'oops' })).status, 400);
  assert.equal((await admin('status')).body.stopped, true);
  assert.equal((await admin('resume', { confirm: 'RESUME BILLABLE WORK' })).body.stopped, false);
  result = await tool('read', { path: '/workspace/proof.txt' }); assert.match(JSON.stringify(result.content), /persistent-marker/);
  // Two existing agents plus at most 49 attempted names: the lifetime quota must be global.
  let agentBlocked = false;
  for (let i = 0; i < 49; i++) {
    const res = await fetch(`${base}/api/object-quota-${i}/debug`, { signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${token}` } });
    if (res.status === 503) { agentBlocked = true; break; }
    assert.equal(res.status, 200);
  }
  assert.ok(agentBlocked, 'New agent names must not bypass the project object quota');
  assert.equal((await admin('status')).body.stopped, true);
  console.log('PASS: lifetime object quota spans all agent IDs and latches global stop.');
  console.log('PASS: authenticated emergency stop blocks new turns, persists after restart, aborts registered sessions best-effort, and requires explicit resume without deleting data.');
  assert.ok(!output.includes('hm_request_failed'), 'Unexpected request failure');
  console.log('PASS: actual Pi tool loop + WorkerLoader calculation, persistent files after workerd restart, DO isolation, host environment/path denial, blocked network, deadline, recovery after timeout.');
} catch (error) { console.error(output.slice(-6000)); throw error; }
finally { await stop(); rmSync(persistence, { recursive: true, force: true }); }
