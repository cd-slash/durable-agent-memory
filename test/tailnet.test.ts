import {it,expect,vi} from 'vitest';
import {sqlite} from './helpers';
import {BillingLedger} from '../src/billing/ledger';
import {SandboxLeases} from '../src/sandbox/leases';
import {SandboxJournal} from '../src/sandbox/journal';
import {TailnetRunner,type TailnetRuntime} from '../src/tailnet/request';
import {targetsFromJson,validateTailnet,tailnetHost} from '../src/tailnet/policy';
const targets=targetsFromJson(JSON.stringify([{name:'test',host:'test.example.ts.net',ports:[22,80],sshUsers:['root']}])) ;
const input={agent:'builder',operationId:'one',target:'test',kind:'tcp' as const,port:22};
function fixture(){
 const {sql,db}=sqlite();const billing=new BillingLedger(sql);const leases=new SandboxLeases(sql,billing);const effects:string[]=[];
 const runtime:TailnetRuntime={acquire:async i=>{effects.push('reserve');return leases.acquire(i.agent,i.operationId,'tailnet');},alarm:async()=>{effects.push('alarm');},active:async t=>{leases.assertActive(t);},start:async()=>{effects.push('start');},request:async()=>{effects.push('request');return {ok:true,banner:'SSH-test'};},destroy:async()=>{effects.push('destroy');},clearAlarm:async()=>{},release:async t=>{effects.push('release');leases.release(t);},failure:async()=>{billing.stop('cleanup');}};
 return {sql,db,billing,leases,effects,runtime,runner:new TailnetRunner(new SandboxJournal(sql),runtime)};
}
it('strict tailnet targets, ports, SSH identities and HTTP paths deny SSRF/header injection',()=>{
 for(const host of ['127.0.0.1','169.254.169.254','example.com','100.128.0.1','100.64.0.999','-a.example.ts.net'])expect(tailnetHost(host)).toBe(false);
 expect(tailnetHost('100.64.0.1')).toBe(true);
 for(const path of ['//evil','/a\r\nX: y','/%0a','/a#b','/a\\b','/a b'])expect(()=>validateTailnet({...input,kind:'http',port:80,path},targets)).toThrow();
 expect(()=>validateTailnet({...input,port:443},targets)).toThrow();expect(()=>validateTailnet({...input,target:'other'},targets)).toThrow();
 expect(()=>validateTailnet({...input,kind:'ssh',user:'ubuntu'},targets)).toThrow();expect(()=>validateTailnet({...input,kind:'ssh',user:'root',port:80},targets)).toThrow();
 expect(validateTailnet({...input,kind:'ssh',user:'root'},targets).name).toBe('test');
 expect(()=>targetsFromJson('[{"name":"t","host":"test.example.ts.net","ports":[22],"sshUsers":["-oProxyCommand=evil"]}]')).toThrow();
});
it('reserves globally before enrollment, destroys before release; replay survives reconstruction without effects',async()=>{
 const f=fixture();const result=await f.runner.run(input);expect(result.ok).toBe(true);
 expect(f.effects).toEqual(['reserve','alarm','start','request','destroy','release']);
 const before=[...f.effects];expect(await new TailnetRunner(new SandboxJournal(f.sql),f.runtime).run(input)).toEqual(result);expect(f.effects).toEqual(before);
 expect((f.billing.status().reservations as any[]).find(r=>r.kind==='executions').used).toBe(1);f.db.close();
});
it('tailnet and coding share a durable slot with retained owner, and stop denies enrollment',async()=>{
 const f=fixture();const lease=f.leases.acquire('builder','coding');expect(lease.owner).toBe('coding');expect(()=>f.leases.acquire('builder','tailnet','tailnet')).toThrow();
 f.leases.release(lease.token);const second=f.leases.acquire('builder','tailnet','tailnet');expect(new SandboxLeases(f.sql,f.billing).status()?.owner).toBe('tailnet');
 f.leases.release(second.token);f.billing.stop('owner');expect((await f.runner.run(input)).ok).toBe(false);expect(f.effects).not.toContain('start');f.db.close();
});
it('failed destruction latches stop and retains occupied slot',async()=>{
 const f=fixture();f.runtime.destroy=async()=>{throw new Error('failure');};expect(await f.runner.run(input)).toMatchObject({ok:false,error:'Gateway cleanup unconfirmed; billing stop requested'});expect(f.billing.status().stopped).toBe(true);expect(f.leases.status()).toBeDefined();f.db.close();
});
it('stop interrupts hanging startup and prevents a late request; overlapping operations denied',async()=>{
 const f=fixture();let ready!:()=>void,finish!:()=>void;const started=new Promise<void>(r=>ready=r);
 f.runtime.start=async()=>{ready();await new Promise<void>(r=>finish=r);};f.runtime.request=vi.fn(async()=>({ok:true}));
 const running=f.runner.run(input);await started;await expect(f.runner.run({...input,operationId:'two'})).rejects.toThrow('busy');f.runner.abort();expect((await running).ok).toBe(false);finish();await Promise.resolve();expect(f.runtime.request).not.toHaveBeenCalled();expect(f.leases.status()).toBeUndefined();f.db.close();
});
it('actual Python gateway tests use local socket fixtures, never enrollment or Cloudflare',async()=>{
 const {execFileSync}=await import('node:child_process');expect(()=>execFileSync('python3',['-m','unittest','discover','-s','sandbox','-p','test*tailnet*.py'],{stdio:'pipe',timeout:15000})).not.toThrow();
});
it('Pi tailnet tool ignores forged agent/operation identity and supports fixed SSH check',async()=>{
 const {tailnetExtension}=await import('../src/tailnet/extension');const bodies:any[]=[];
 const agent={projectName:()=> 'builder',tailnetTargets:()=>JSON.stringify(targets),billing:{assertRunning:async()=>{}},tailnetGateway:{fetch:async(_url:string,init:any)=>{bodies.push(JSON.parse(init.body));return Response.json({ok:true,banner:'TAILNET_SSH_OK'});}}};
 const tool=tailnetExtension(agent as any).tools!.find(t=>t.name==='tailnet_ssh_check')!;const api={conversationId:'epoch',taskId:'task',callId:'call'};
 await tool.execute({target:'test',port:22,user:'root',agent:'forged',operationId:'fake'},api as any,{abortSignal:new AbortController().signal} as any);
 expect(bodies[0]).toMatchObject({agent:'builder',kind:'ssh',user:'root'});expect(bodies[0].operationId).toMatch(/^[a-f0-9]{64}$/);
});

it('startup failures report a safe phase without echoing platform messages or credentials',async()=>{
 const f=fixture();f.runtime.start=async()=>{throw new Error('private-provider-message');};const result=await f.runner.run(input);expect(result.error).toContain('startup');expect(JSON.stringify(result)).not.toContain('private-provider-message');expect(f.leases.status()).toBeUndefined();f.db.close();
});
