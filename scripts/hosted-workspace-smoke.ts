import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = process.env.BRIDGE_REMOTE_URL;
const tokenFile = process.env.BRIDGE_TOKEN_FILE;
if (!base || !tokenFile || !base.startsWith('https://')) throw new Error('Set BRIDGE_REMOTE_URL and BRIDGE_TOKEN_FILE (never pass a token on the command line)');
const token = (await readFile(tokenFile, 'utf8')).trim();
const agent = `hosted-workspace-${Date.now()}`;
console.log('Hosted test agent:', agent);
async function api(action: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}/api/${agent}/${action}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
  assert.ok(res.ok, `${action}: HTTP ${res.status}`); return res.json();
}
async function turn(message: string) {
  const result = await api('chat', { message, operationId: crypto.randomUUID() });
  assert.equal(result.status, 'done');
  const { messages } = await api('rpc', { type: 'get_messages' });
  const userIndex = messages.findLastIndex((m: any) => m.role === 'user');
  const suffix = messages.slice(userIndex + 1);
  const tools = suffix.filter((m: any) => m.role === 'toolResult');
  const answer = suffix.filter((m: any) => m.role === 'assistant').at(-1);
  assert.ok(answer); assert.equal(answer.stopReason, 'stop', 'Model must finish normally after tool use');
  console.log('Hosted turn:', tools.map((t: any) => ({ tool: t.toolName, isError: !!t.isError })), answer.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').slice(0, 1000));
  return { tools, answer, messages };
}
const capabilities = await api('debug');
const executionEnabled = capabilities.capabilities.execution === 'isolated-javascript';
const first = await turn(executionEnabled ? 'Use exec to compute the sum of the squares of integers 1 through 100 in JavaScript. Write JSON {total: the result, marker: "workspace-proof"} to /workspace/result.json using node:fs/promises. Return the actual result, then briefly explain it. Do not just provide code; execute it.' : 'Use write to create /workspace/result.json containing exactly {"total":338350,"marker":"workspace-proof"}. Tell me when the write succeeded.');
assert.ok(first.tools.some((t: any) => t.toolName === (executionEnabled ? 'exec' : 'write')), 'Model must call the real workspace tool');
if (executionEnabled) assert.match(JSON.stringify(first.tools), /338350/);
const second = await turn('Read /workspace/result.json using a workspace tool and tell me its total and marker. Do not rewrite it.');
assert.ok(second.tools.some((t: any) => ['read', 'exec'].includes(t.toolName)));
assert.match(JSON.stringify(second.tools), /workspace-proof/);
assert.match(JSON.stringify(second.answer), /338[,.]?350/);
const third = await turn('Use web_fetch to read https://raw.githubusercontent.com/cloudflare/agents/main/README.md . Briefly describe what project it documents, and cite the source URL.');
const fetched = third.tools.find((t: any) => t.toolName === 'web_fetch');
assert.ok(fetched && !fetched.isError, 'Real web fetch must succeed');
assert.match(JSON.stringify(fetched), /Cloudflare/i);
const debug = await api('debug');
assert.equal(debug.localTest, false);
console.log(`PASS: hosted Workers AI ${executionEnabled ? 'executed isolated JavaScript and ' : ''}wrote/read persistent files across turns, continued with normal answers, and fetched a real cited source. Execution enabled: ${executionEnabled}.`, agent);
