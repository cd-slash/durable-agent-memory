import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {BILLING_LIMITS} from '../src/billing/policy';
import {SANDBOX} from '../src/sandbox/policy';
import {cappedBody} from '../src/sandbox/network';
if(!process.argv.includes('--confirm-one-tailnet-attempt'))throw new Error('Explicit finite hosted-test confirmation required; reserves one execution/tool,90seconds,6MiB storage,8MiB network; zero inference');
const base=process.env.BRIDGE_URL??'https://durable-agent-memory.cloudflare-henry.workers.dev';
const token=readFileSync(process.env.BRIDGE_TOKEN_FILE??'/home/coder/.config/durable-agent-memory/demo-token','utf8').trim();
const target=process.env.TAILNET_TEST_TARGET;if(!target)throw new Error('Set TAILNET_TEST_TARGET to the approved allowlist name');
async function call(path:string,body?:unknown){
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(body?110000:10000)});
 const bytes=await cappedBody(response.body as ReadableStream<Uint8Array>|null,65536,AbortSignal.timeout(10000));
 if(!response.ok)throw new Error(`Hosted request denied: ${path}, HTTP ${response.status}; no retry`);
 return JSON.parse(new TextDecoder().decode(bytes));
}
const before=await call('/admin/billing/status');assert.equal(before.stopped,false,'Do not resume/reset usage for smoke');assert.equal(before.sandbox.lease,null,'Global execution slot occupied');
function used(status:any,kind:string,period:string){return status.reservations.find((r:any)=>r.kind===kind&&r.period===period)?.used??0;}
for(const [kind,amount] of Object.entries({executions:1,tools:1,sandboxSeconds:90,sandboxNetworkBytes:SANDBOX.networkBytes,storageBytes:SANDBOX.storageReservation+65536,requests:1})){
 const limits=BILLING_LIMITS[kind as keyof typeof BILLING_LIMITS];assert.ok(used(before,kind,before.day)+amount<=limits.day,`${kind} daily headroom missing`);assert.ok(used(before,kind,before.month)+amount<=limits.month,`${kind} monthly headroom missing`);
}
const configuration=await call('/admin/tailnet/status');assert.ok(configuration.enabled&&configuration.configured,'Gateway must already be configured');assert.equal(configuration.running,false);
const result=await call('/admin/tailnet/run',{agent:process.env.TAILNET_TEST_AGENT??'tailnet-check',operationId:crypto.randomUUID(),target,kind:'ssh',port:22,user:process.env.TAILNET_TEST_USER??'root'});
// Inspection is read-only and always finite, even after failure. Never repeat the operation.
const gateway=await call('/admin/tailnet/status');const after=await call('/admin/billing/status');
console.log(JSON.stringify({result,gatewayDestroyed:!gateway.running,leaseReleased:after.sandbox.lease===null,stopped:after.stopped,delta:{executions:used(after,'executions',after.day)-used(before,'executions',before.day),tools:used(after,'tools',after.day)-used(before,'tools',before.day),aiCalls:used(after,'aiCalls',after.day)-used(before,'aiCalls',before.day),storageBytes:used(after,'storageBytes',after.day)-used(before,'storageBytes',before.day)}},null,2));
assert.ok(result.ok&&result.banner?.startsWith('TAILNET_SSH_OK\n'),'Hosted SSH check failed; do not retry automatically');assert.equal(gateway.running,false,'Destruction unconfirmed');assert.equal(after.sandbox.lease,null,'Lease release unconfirmed');assert.equal(after.stopped,false,'Billing stopped; do not resume for smoke');
