import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SANDBOX } from '../src/sandbox/policy';
if (!process.argv.includes('--confirm-live-sandbox-smoke')) throw new Error('Requires separately approved activation and explicit finite live smoke confirmation');
const tokenFile=process.env.BRIDGE_TOKEN_FILE;
if (!tokenFile) throw new Error('Use BRIDGE_TOKEN_FILE; never put credentials in chat/command arguments');
const token=readFileSync(tokenFile,'utf8').trim();
const base=process.env.BRIDGE_URL ?? 'https://durable-agent-memory.cloudflare-henry.workers.dev';
async function api(path:string,body?:unknown) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(110000)});
  if(!response.ok)throw new Error('Hosted sandbox denied; stopping without retry or quota reset');
  return response.json() as Promise<any>;
}
const before=await api('/admin/billing/status');
assert.equal(before.stopped,false,'Do not implicitly resume');assert.equal(before.sandbox?.enabled,true,'Sandbox must already be approved/activated');assert.equal(before.sandbox.lease,null,'Do not compete with an active sandbox');
const kinds={requests:2,tools:2,executions:2,storageBytes:2*SANDBOX.storageReservation+65536,sandboxSeconds:180,sandboxNetworkBytes:2*SANDBOX.networkBytes};
for(const [kind,amount] of Object.entries(kinds)) for(const [period,key] of [[before.day,'day'],[before.month,'month']] as const){
  const used=before.reservations.find((r:any)=>r.kind===kind&&r.period===period)?.used??0;
  assert.ok(used+amount<=before.limits[kind][key],`${kind} ${key} headroom inadequate; do not reset or retry`);
}
const lifetime=before.reservations.find((r:any)=>r.kind==='storageBytes'&&r.period==='lifetime')?.used??0;
assert.ok(lifetime+kinds.storageBytes<=128*1048576,'Lifetime storage headroom inadequate');
const agent='sandbox-smoke';const marker='sandbox-proof-'+crypto.randomUUID();
const first=await api('/admin/sandbox/run',{agent,operationId:crypto.randomUUID(),command:`set -eu; printf 'console.log(6 * 7)\\n' > main.js; printf '%s' '${marker}' > proof.txt; git init -q .; git add main.js proof.txt; node main.js; python3 -c 'print(6*7)'; git status --short`,timeoutMs:20000});
assert.equal(first.exitCode,0);assert.equal(first.checkpointed,true);assert.match(first.stdout,/42/);
const second=await api('/admin/sandbox/run',{agent,operationId:crypto.randomUUID(),command:'set -eu; cat proof.txt; node main.js; git status --short',timeoutMs:20000});
assert.equal(second.exitCode,0);assert.equal(second.checkpointed,true);assert.ok(second.stdout.includes(marker));assert.match(second.stdout,/main\.js/);
const status=await api('/admin/sandbox/status');assert.equal(status.running,false);
const after=await api('/admin/billing/status');assert.equal(after.sandbox.lease,null);
for(const kind of ['aiCalls','neurons','turns']){
  const used=(state:any)=>state.reservations.find((r:any)=>r.kind===kind&&r.period===state.day)?.used??0;
  assert.equal(used(after),used(before),`No ${kind} expected; concurrent traffic can invalidate this observation`);
}
console.log('PASS: two bounded native Linux executions, Node/Python/Git, SQLite source/Git restore in fresh container, confirmed destruction and lease release. No inference.');
