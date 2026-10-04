import assert from 'node:assert/strict';
const base = process.env.DEMO_URL ?? 'http://localhost:8787';
const token = process.env.DEMO_TOKEN;
if (!token) throw new Error('Set DEMO_TOKEN in the process environment (never commit it)');
const agent = process.env.DEMO_AGENT ?? `smoke-${Date.now()}`;
async function api(action: string, body?: unknown, id?: string): Promise<any> {
  const response = await fetch(`${base}/api/${agent}/${action}${id ? '?id=' + encodeURIComponent(id) : ''}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${action}: HTTP ${response.status}`);
  return response.json();
}
const health = await (await fetch(base + '/health')).json() as { ok: boolean; localTest: boolean };
assert.ok(health.ok);
const unauthenticated = await fetch(`${base}/api/${agent}/debug`);
assert.equal(unauthenticated.status, 401);
const preference = await api('remember', { content: 'My favourite database for small projects is SQLite.', kind: 'preference', namespace: 'preferences', idempotencyKey: 'smoke-sqlite' });
const replay = await api('remember', { content: 'My favourite database for small projects is SQLite.', kind: 'preference', namespace: 'preferences', idempotencyKey: 'smoke-sqlite' });
assert.equal(preference.id, replay.id);
const decision = await api('remember', { content: 'Decision: route vision requests to Z.AI and text-only requests to Cerebras.', kind: 'decision', namespace: 'decisions', idempotencyKey: 'smoke-routing' });
for (let i = 1; i < 16; i++) await api('remember', { content: `Episode ${i}: routine project maintenance was completed.`, kind: 'episode', namespace: 'decisions', idempotencyKey: `smoke-noise-${i}` });
await api('compact', {});
const debug = await api('debug');
const root = debug.nodes.find((n: any) => n.level === 4 && n.namespace === 'decisions');
assert.ok(root && root.eventIds.includes(decision.id));
assert.ok((await api('read', undefined, root.id)).l1);
assert.equal((await api('expand', undefined, root.id)).length, 2);
const raw = await api('read', undefined, decision.id); assert.ok(raw.content.includes('Cerebras'));
const hits = await api('search', { query: 'SQLite database', namespaces: ['preferences'] });
assert.ok(hits.some((h: any) => h.provenance.eventIds.includes(preference.id)));
const context = await api('context', { query: 'Which database would I choose?', maxTokens: 4000 });
assert.ok(context.tokens <= 4000); assert.ok(context.text.includes('SQLite'));
if (!health.localTest) {
  const semantic = await api('search', { query: 'Which datastore do I prefer?', namespaces: ['preferences'], weights: { semantic: 1, lexical: 0, recency: 0 } });
  assert.ok(semantic.some((h: any) => h.provenance.eventIds.includes(preference.id) && h.signals.semantic > 0));
  assert.ok(debug.embeddingModels.length > 0);
}
const first = await api('chat', { message: 'What database would I probably choose for a small project? Explain the source.', operationId: 'smoke-chat-1' });
assert.equal(first.status, 'done'); assert.ok(first.retrieval.text.includes('SQLite'));
const prefix = (await api('debug')).transcript;
await api('remember', { content: 'I like espresso after lunch.', kind: 'preference', namespace: 'preferences', idempotencyKey: 'smoke-coffee' });
assert.deepEqual((await api('debug')).transcript, prefix);
const second = await api('chat', { message: 'What was the old vision routing decision?', operationId: 'smoke-chat-2' });
assert.equal(second.status, 'done');
await api('reset', { query: 'database preference and vision routing' });
const fresh = await api('chat', { message: 'In this new context, what database would I probably choose?', operationId: 'smoke-chat-3' });
assert.equal(fresh.status, 'done'); assert.ok(fresh.retrieval.text.includes('SQLite'));
console.log(JSON.stringify({ ok: true, agent, localTest: health.localTest, events: (await api('debug')).events.length, nodes: debug.nodes.length, checks: ['authentication', 'idempotent writes', 'binary tree', 'L0/L1/L2', 'context budget', 'Pi chat', 'unchanged transcript after write', 'new cache epoch', ...(health.localTest ? [] : ['Workers AI semantic embeddings'])] }, null, 2));
