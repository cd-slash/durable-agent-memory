import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const base = process.env.DEMO_URL;
const token = process.env.DEMO_TOKEN;
const agent = process.env.DEMO_AGENT;
if (!base || !token || !agent) throw new Error('Set DEMO_URL, DEMO_TOKEN and DEMO_AGENT to an existing smoke-tested agent');
async function debug(): Promise<any> {
  const response = await fetch(`${base}/api/${agent}/debug`, { headers: { authorization: `Bearer ${token}` } });
  assert.ok(response.ok); return response.json();
}
const before = await debug();
assert.ok(before.events.length && before.transcript.length, 'Use an agent with retained memories and completed Pi turns');
assert.equal(before.pending, 0, 'Finish summaries before a recovery comparison');
const deploy = spawnSync('node_modules/.bin/wrangler', ['deploy'], { stdio: 'inherit', env: process.env });
assert.equal(deploy.status, 0, 'Deployment failed');
let after;
for (let attempt = 0; attempt < 30; attempt++) {
  after = await debug();
  if (after.bootId !== before.bootId) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.notEqual(after.bootId, before.bootId, 'A new object incarnation was not observed');
assert.deepEqual(after.events, before.events);
assert.deepEqual(after.nodes, before.nodes);
assert.deepEqual(after.transcript, before.transcript);
assert.deepEqual(after.epochs, before.epochs);
console.log(JSON.stringify({ ok: true, agent, restarted: true, events: after.events.length, nodes: after.nodes.length, transcriptEntries: after.transcript.length }, null, 2));
