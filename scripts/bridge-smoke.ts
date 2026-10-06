import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const remote = process.env.BRIDGE_REMOTE_URL;
const base = remote ?? 'http://127.0.0.1:8792';
const folder = mkdtempSync(join(tmpdir(), 'pi-bridge-smoke-'));
const token = remote ? readFileSync(process.env.BRIDGE_TOKEN_FILE!, 'utf8').trim() : 'local-bridge-test-only';
const tokenFile = join(folder, 'token'), configFile = join(folder, 'bridge.json');
writeFileSync(tokenFile, token, { mode: 0o600 });
writeFileSync(configFile, JSON.stringify({ url: base, tokenFile, sessionsDir: join(folder, 'sessions') }), { mode: 0o600 });
let worker: ChildProcess | undefined;
let logs = '';
async function startWorker() {
  if (remote) return;
  worker = spawn('node_modules/.bin/wrangler', ['dev', '--local', '--port', '8792', '--persist-to', join(folder, 'worker'), '--var', 'LOCAL_TEST:true', '--var', `DEMO_TOKEN:${token}`], { stdio: 'pipe', detached: true });
  worker.stdout!.on('data', c => { logs += c; }); worker.stderr!.on('data', c => { logs += c; });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    if (worker.exitCode !== null) throw new Error('Local worker exited');
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Local worker startup timed out');
}
async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  const done = new Promise<void>(r => worker!.once('exit', () => r()));
  process.kill(-worker.pid!, 'SIGTERM'); await done; worker = undefined;
}
class Client {
  proc: ChildProcess;
  records: any[] = [];
  stderr = '';
  constructor(session?: string) {
    this.proc = spawn(resolve('bin/pi-durable'), ['--mode', 'rpc', ...(session ? ['--session', session] : []), '--extension', '/tmp/t3-injected-extension.ts'], { env: { ...process.env, PI_DURABLE_CONFIG: configFile }, stdio: 'pipe' });
    createInterface({ input: this.proc.stdout! }).on('line', line => this.records.push(JSON.parse(line)));
    this.proc.stderr!.on('data', chunk => { this.stderr += chunk; });
  }
  async wait(predicate: (record: any) => boolean, after = 0): Promise<any> {
    for (let i = 0; i < 1500; i++) {
      const found = this.records.slice(after).find(predicate);
      if (found) return found;
      if (this.proc.exitCode !== null) throw new Error('Bridge process exited');
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('Bridge RPC timed out');
  }
  async rpc(type: string, data: object = {}) {
    const id = crypto.randomUUID(), after = this.records.length;
    this.proc.stdin!.write(JSON.stringify({ type, ...data, id }) + '\n');
    const response = await this.wait(r => r.type === 'response' && r.id === id, after);
    assert.equal(response.success, true, `RPC ${type}: ${response.error}`);
    return response.data;
  }
  async prompt(message: string) {
    const after = this.records.length;
    this.proc.stdin!.write(JSON.stringify({ type: 'prompt', message }) + '\n');
    await this.wait(r => r.type === 'agent_settled', after);
    const records = this.records.slice(after);
    assert.ok(records.some(r => r.type === 'agent_start'));
    assert.ok(records.some(r => r.type === 'response' && r.command === 'prompt' && r.success));
    return records.filter(r => r.type === 'message_update' && r.assistantMessageEvent?.type === 'text_delta').map(r => r.assistantMessageEvent.delta).join('');
  }
  async close() { const done = new Promise<void>(r => this.proc.once('exit', () => r())); this.proc.kill(); await done; }
}
let client: Client | undefined;
async function api(agent: string, action: string, body?: unknown): Promise<any> {
  const response = await fetch(`${base}/api/${agent}/${action}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${action} HTTP ${response.status}`); return response.json();
}
try {
  await startWorker();
  client = new Client();
  const state = await client.rpc('get_state'), sessionFile = state.sessionFile, agent = state.sessionId;
  assert.ok(sessionFile && state.model.id);
  assert.ok((await client.rpc('get_available_models')).models.length === 1);
  assert.deepEqual(await client.rpc('get_commands'), { commands: [] });
  await client.rpc('set_model', { provider: state.model.provider, modelId: state.model.id });
  await client.rpc('set_thinking_level', { level: 'off' });
  const denied = await fetch(`${base}/api/${agent}/rpc`, { method: 'POST', body: JSON.stringify({ type: 'get_state' }) });
  assert.equal(denied.status, 401);
  assert.equal((await fetch(`${base}/api/${agent}/events?operationId=no-such-op`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  await api(agent, 'remember', { content: 'My favourite database for small projects is SQLite.', kind: 'preference' });
  await api(agent, 'compact', {});
  const text = await client.prompt('What database do I prefer for small projects? Answer briefly.');
  assert.ok(text.length > 0);
  const before = await api(agent, 'debug');
  await api(agent, 'remember', { content: 'I like espresso.', kind: 'preference' });
  assert.deepEqual((await api(agent, 'debug')).transcript, before.transcript, 'Memory write must not change transcript prefix');
  await client.close(); client = new Client(sessionFile);
  assert.equal((await client.rpc('get_state')).sessionId, agent);
  assert.ok((await client.rpc('get_messages')).messages.length >= 2);
  const entries = await client.rpc('get_entries');
  assert.ok(entries.leafId && entries.entries.some((e: any) => e.message.role === 'user'));
  assert.deepEqual((await client.rpc('get_entries', { since: entries.leafId })).entries, []);
  if (!remote) {
    await client.close(); client = undefined;
    await stopWorker(); await startWorker();
    assert.deepEqual((await api(agent, 'debug')).transcript, before.transcript);
    client = new Client(sessionFile);
    assert.ok((await client.prompt('What database would I choose after a restart?')).length > 0);
    const after = client.records.length;
    client.proc.stdin!.write(JSON.stringify({ type: 'prompt', message: 'slow bridge cancellation' }) + '\n');
    await client.wait(r => r.type === 'agent_start', after);
    await client.rpc('abort');
    await client.wait(r => r.type === 'agent_settled', after);
    assert.equal((await client.rpc('get_state')).isStreaming, false);
    // Kill both observer and Worker during generation, then replay the original
    // RPC prompt. The manifest must reuse its durable operation, not append twice.
    const restartAfter = client.records.length;
    client.proc.stdin!.write(JSON.stringify({ type: 'prompt', message: 'slow bridge cancellation recovery' }) + '\n');
    await client.wait(r => r.type === 'agent_start', restartAfter);
    await client.close(); client = undefined;
    await stopWorker(); await startWorker();
    client = new Client(sessionFile);
    assert.ok((await client.prompt('slow bridge cancellation recovery')).length > 0);
    const recovered = await api(agent, 'debug');
    const replayed = recovered.transcript.flatMap((e: any) => e.model ?? []).filter((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('slow bridge cancellation recovery'));
    assert.equal(replayed.length, 1, 'Restart must not duplicate the accepted user input');
  }
  // A new session must not share another chat's transcript/memory.
  await client.rpc('new_session');
  const fresh = await client.rpc('get_state');
  assert.notEqual(fresh.sessionFile, sessionFile);
  assert.deepEqual((await client.rpc('get_messages')).messages, []);
  assert.deepEqual((await api(fresh.sessionId, 'debug')).events, []);
  await client.rpc('switch_session', { sessionPath: sessionFile });
  assert.equal((await client.rpc('get_state')).sessionId, agent);
  assert.ok(!logs.includes('hm_request_failed') && !logs.includes('pi_report'), 'Worker reported runtime errors');
  assert.ok(!client.stderr.includes(token) && !logs.includes(token), 'Secret leaked into logs');
  console.log(`PASS: ${remote ? 'deployed Workers AI' : 'local real workerd'} → executable JSONL RPC bridge: model discovery, streamed chat, auth, immutable prefix, process resume, ${remote ? '' : 'Worker restart, abort, '}session isolation. Agent: ${agent}`);
} finally { await client?.close(); await stopWorker(); rmSync(folder, { recursive: true, force: true }); }
