import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const port = 8794, token = 'local-workspace-test';
const base = `http://127.0.0.1:${port}`;
let proc: ReturnType<typeof spawn> | undefined;
let output = '';
const agent = `workspace-test-${Date.now()}`;
async function start() {
  output = '';
  proc = spawn('node_modules/.bin/wrangler', ['dev', '--local', '--port', String(port), '--var', 'LOCAL_TEST:true', '--var', `DEMO_TOKEN:${token}`], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
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
  const res = await fetch(`${base}/api/${id}/${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
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
  assert.match(JSON.stringify(result.content), /outside|escape|denied|error|must stay under/i);
  result = await tool('exec', { command: "export default async () => { try { await fetch('https://example.com'); return 'NETWORK_ALLOWED'; } catch { return 'NETWORK_BLOCKED'; } }", cwd: '/workspace' });
  assert.match(JSON.stringify(result.content), /NETWORK_BLOCKED/);
  const began = Date.now();
  result = await tool('exec', { command: 'export default async () => new Promise(() => {})', cwd: '/workspace' });
  assert.ok(Date.now() - began < 15000, 'Execution deadline must bound nonterminating code');
  assert.match(JSON.stringify(result.content), /timeout|timed out|deadline|exceed|error/i);
  result = await tool('exec', { command: 'export default () => 7', cwd: '/workspace' }); assert.match(JSON.stringify(result.content), /7/);
  assert.ok(!output.includes('hm_request_failed'), 'Unexpected request failure');
  console.log('PASS: actual Pi tool loop + WorkerLoader calculation, persistent files after workerd restart, DO isolation, host environment/path denial, blocked network, deadline, recovery after timeout.');
} catch (error) { console.error(output.slice(-6000)); throw error; }
finally { await stop(); }
