import { it, expect, vi } from 'vitest';
import { sqlite } from './helpers';
import { BillingLedger } from '../src/billing/ledger';
import { SandboxLeases } from '../src/sandbox/leases';
import { SandboxJournal } from '../src/sandbox/journal';
import { SandboxRunner, type SandboxRuntime } from '../src/sandbox/runner';
import { boundedProcess, type ShellProcess } from '../src/sandbox/process';
import { allowedSandboxRequest, sandboxNetwork, cappedBody } from '../src/sandbox/network';
import { SANDBOX, validateShell } from '../src/sandbox/policy';
const stream = (s:string)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(s));c.close();}});
function process(stdout='',exitCode=0):ShellProcess { return {stdout:stream(stdout),stderr:stream(''),exitCode:Promise.resolve(exitCode),kill:vi.fn()}; }
function fixture() {
  const {sql,db}=sqlite();const billing=new BillingLedger(sql);const leases=new SandboxLeases(sql,billing);const journal=new SandboxJournal(sql);
  let currentAgent=''; const effects:string[]=[];
  const runtime:SandboxRuntime={
    acquire:async input=>{effects.push('reserve');currentAgent=input.agent;return leases.acquire(input.agent,input.operationId);},
    assertActive:async token=>{leases.assertActive(token);},alarm:async()=>{effects.push('alarm');},
    start:async()=>{effects.push('start');},
    exec:async(command,_signal,stdin)=>{
      effects.push(command.at(-1)!);
      if(command.at(-1)==='restore'){ expect(JSON.parse(stdin!).files).toBeDefined();return process(); }
      if(command.at(-1)==='pack')return process(JSON.stringify({version:1,files:[{path:'agent.txt',data:btoa(currentAgent),executable:false}]}));
      return process('verified',0);
    },
    destroy:async()=>{effects.push('destroy');},release:async token=>{effects.push('release');leases.release(token);},failure:async()=>{billing.stop('cleanup failed');},clearAlarm:async()=>{},
  };
  return {sql,db,billing,leases,journal,runtime,effects,runner:new SandboxRunner(journal,runtime)};
}
it('sandbox leases serialize globally, reserve before effects and never recycle expired slots',()=>{
  const {sql,db}=sqlite();const billing=new BillingLedger(sql);let now=1000;const leases=new SandboxLeases(sql,billing,()=>now);
  const lease=leases.acquire('builder','op1');expect(lease.deadline).toBe(91000);
  expect(()=>leases.acquire('reviewer','op2')).toThrow('occupied');now=100000;
  expect(()=>new SandboxLeases(sql,billing,()=>now).acquire('reviewer','op2')).toThrow('occupied');
  expect(()=>leases.assertActive(lease.token)).toThrow();leases.release('wrong-token');expect(leases.status()).toBeDefined();
  leases.release(lease.token);expect(leases.status()).toBeUndefined();
  const usage=billing.status().reservations as any[];
  expect(usage.find(r=>r.kind==='sandboxSeconds')).toMatchObject({used:90});expect(usage.find(r=>r.kind==='executions')).toMatchObject({used:1});db.close();
});
it('existing storage quota can deny sandbox before new limits; all reservations are atomic',()=>{
  const f=fixture();f.billing.reserve({storageBytes:11*1048576});
  expect(()=>f.leases.acquire('builder','op')).toThrow('storageBytes');
  expect(f.leases.status()).toBeUndefined();expect((f.billing.status().reservations as any[]).some(r=>r.kind==='sandboxSeconds')).toBe(false);f.db.close();
});
it('emergency stop denies starts/network but permits cleanup; resume never resets sandbox usage',()=>{
  const f=fixture();const lease=f.leases.acquire('builder','op');f.billing.stop('owner');
  expect(()=>f.leases.network(lease.token,0)).toThrow();f.leases.release(lease.token);expect(()=>f.leases.acquire('builder','op2')).toThrow();
  f.billing.resume();expect((f.billing.status().reservations as any[]).find(r=>r.kind==='sandboxSeconds')).toMatchObject({used:90});f.db.close();
});
it('network attempts have conservative durable accounting and expired/wrong-token rejection',()=>{
  const f=fixture();const lease=f.leases.acquire('builder','op');
  expect(()=>f.leases.network('forged',0)).toThrow();expect(()=>f.leases.network(lease.token,32769)).toThrow();
  for(let i=0;i<4;i++)f.leases.network(lease.token,0);
  expect(f.leases.status()).toMatchObject({networkRequests:4,networkBytes:8*1048576});
  expect(()=>f.leases.network(lease.token,0)).toThrow('network quota');f.db.close();
});
it('completed jobs checkpoint isolated agent files, destroy, then release, and replay without effects',async()=>{
  const f=fixture();const input={agent:'builder',operationId:'call1',command:'printf verified'};
  const result=await f.runner.run(input);expect(result).toMatchObject({exitCode:0,stdout:'verified',checkpointed:true});
  expect(f.effects).toEqual(['reserve','alarm','start','restore','printf verified','pack','destroy','release']);
  const before=[...f.effects];expect(await new SandboxRunner(new SandboxJournal(f.sql),f.runtime).run(input)).toEqual(result);expect(f.effects).toEqual(before);
  expect(JSON.parse(f.journal.checkpoint('builder')).files[0].data).toBe(btoa('builder'));expect(JSON.parse(f.journal.checkpoint('reviewer')).files).toEqual([]);
  expect((f.billing.status().reservations as any[]).find(r=>r.kind==='executions')).toMatchObject({used:1});f.db.close();
});
it('nonzero completed commands retain checkpoint but report their exit code; overflow cancels and destroys',async()=>{
  const f=fixture();const original=f.runtime.exec;
  f.runtime.exec=async(...args)=>args[0][0]==='/bin/sh'?process('',7):original(...args);
  expect(await f.runner.run({agent:'builder',operationId:'badexit',command:'exit 7'})).toMatchObject({exitCode:7,checkpointed:true});
  f.runtime.exec=async(...args)=>args[0][0]==='/bin/sh'?process('x'.repeat(SANDBOX.outputBytes+1)):original(...args);
  expect(await f.runner.run({agent:'builder',operationId:'overflow',command:'yes'})).toMatchObject({exitCode:1,checkpointed:false});
  expect(f.effects.filter(e=>e==='destroy')).toHaveLength(2);expect(f.leases.status()).toBeUndefined();f.db.close();
});
it('failed cleanup retains the global slot and latches stop; another agent cannot multiply containers',async()=>{
  const f=fixture();f.runtime.destroy=async()=>{throw new Error('platform failure');};
  const result=await f.runner.run({agent:'builder',operationId:'call1',command:'true'});
  expect(result.error).toContain('cleanup unconfirmed');expect(f.billing.status().stopped).toBe(true);expect(f.leases.status()).toBeDefined();
  expect(()=>f.leases.acquire('reviewer','call2')).toThrow('occupied');f.db.close();
});
it('single-flight rejects competing agents and cancellation destroys an uncooperative process',async()=>{
  const f=fixture();let started!:()=>void;const start=new Promise<void>(resolve=>{started=resolve;});
  const proc:ShellProcess={stdout:new ReadableStream(),stderr:null,exitCode:new Promise(()=>{}),kill:vi.fn()};const original=f.runtime.exec;
  f.runtime.exec=async(...args)=>{if(args[0][0]==='/bin/sh'){started();return proc;}return original(...args);};
  const running=f.runner.run({agent:'builder',operationId:'hang',command:'sleep infinity'});await start;
  await expect(f.runner.run({agent:'reviewer',operationId:'other',command:'true'})).rejects.toThrow('busy');
  f.runner.abort();expect(await running).toMatchObject({exitCode:1,checkpointed:false});expect(proc.kill).toHaveBeenCalledWith(9);expect(f.leases.status()).toBeUndefined();f.db.close();
});
it('combined stdout/stderr cap and deadline apply even if process ignores kill and streams never close',async()=>{
  const proc=process('abc');proc.stderr=stream('def');await expect(boundedProcess(proc,5,new AbortController().signal)).rejects.toThrow('output limit');
  const hanging:ShellProcess={stdout:new ReadableStream(),stderr:null,exitCode:new Promise(()=>{}),kill:vi.fn()};const abort=new AbortController();
  const result=boundedProcess(hanging,5,abort.signal);abort.abort();await expect(result).rejects.toThrow('interrupted');expect(hanging.kill).toHaveBeenCalled();
});
it('rejects private/credentialed, arbitrary host/port, redirects, uploads and over-limit network bodies before outbound',async()=>{
  for(const url of ['http://registry.npmjs.org/a','https://127.0.0.1/a','https://registry.npmjs.org:444/a','https://example.org/a','https://github.com/a/b.git/git-receive-pack','https://registry.npmjs.org/a?secret=x'])expect(allowedSandboxRequest(new Request(url))).toBe(false);
  expect(allowedSandboxRequest(new Request('https://github.com/a/b.git/info/refs?service=git-upload-pack'))).toBe(true);
  expect(allowedSandboxRequest(new Request('https://registry.npmjs.org/is-number'))).toBe(true);
  expect(allowedSandboxRequest(new Request('https://registry.npmjs.org/a',{headers:{authorization:'secret'}}))).toBe(false);
  const outbound=vi.fn(async()=>new Response('payload'));const reserve=vi.fn(async()=>{});
  expect((await sandboxNetwork(new Request('https://example.org'),reserve,outbound as any)).status).toBe(403);expect(outbound).not.toHaveBeenCalled();
  expect(await (await sandboxNetwork(new Request('https://registry.npmjs.org/is-number'),reserve,outbound as any)).text()).toBe('payload');expect(reserve).toHaveBeenCalledWith(0);
  const redirect=vi.fn(async()=>new Response(null,{status:302,headers:{location:'https://evil.test'}}));expect((await sandboxNetwork(new Request('https://registry.npmjs.org/a'),reserve,redirect as any)).status).toBe(403);expect(redirect).toHaveBeenCalledOnce();
  await expect(cappedBody(stream('abcdef'),5)).rejects.toThrow('byte limit');
});
it('bounds command inputs and stores replay tombstones and chunked checkpoints across journal reconstruction',()=>{
  expect(()=>validateShell({agent:'a',operationId:'b',command:'true',timeoutMs:30001})).toThrow();
  const f=fixture();f.journal.start('stable','builder','hash');
  expect(()=>new SandboxJournal(f.sql).start('stable','builder','hash')).toThrow('replay denied');
  f.journal.finish('stable',{exitCode:1,stdout:'',stderr:'',checkpointed:false,error:'interrupted'});
  expect(()=>f.journal.start('stable','builder','other')).toThrow('different input');
  const archive=JSON.stringify({version:1,files:[{path:'x',data:'a'.repeat(200000)}]});f.journal.save('builder',archive);
  expect(new SandboxJournal(f.sql).checkpoint('builder')).toBe(archive);expect(f.sql.all('SELECT * FROM sbx_checkpoints')).toHaveLength(4);f.db.close();
});

it('actual Linux checkpoint implementation preserves source/Git and rejects traversal, symlinks, FIFOs and size overflow',async()=>{
  const {execFileSync}=await import('node:child_process');
  expect(()=>execFileSync('python3',['sandbox/test_checkpoint.py'],{stdio:'pipe'})).not.toThrow();
});
it('command timeout also bounds a native exec call that never returns a process',async()=>{
  const f=fixture();const original=f.runtime.exec;
  f.runtime.exec=async(...args)=>args[0][0]==='/bin/sh'?new Promise(()=>{}):original(...args);
  const result=await f.runner.run({agent:'builder',operationId:'hung-native',command:'true',timeoutMs:10});
  expect(result).toMatchObject({exitCode:1,checkpointed:false});expect(f.effects).toContain('destroy');expect(f.leases.status()).toBeUndefined();f.db.close();
});
it('cancellation can only target the matching agent and durable call id',async()=>{
  const f=fixture();let started!:()=>void;const start=new Promise<void>(r=>{started=r;});const original=f.runtime.exec;
  const proc:ShellProcess={stdout:null,stderr:null,exitCode:new Promise(()=>{}),kill:vi.fn()};
  f.runtime.exec=async(...args)=>{if(args[0][0]==='/bin/sh'){started();return proc;}return original(...args);};
  const result=f.runner.run({agent:'builder',operationId:'owned',command:'sleep 10'});await start;
  f.runner.cancel('reviewer','owned');f.runner.cancel('builder','other');expect(proc.kill).not.toHaveBeenCalled();
  f.runner.cancel('builder','owned');expect(await result).toMatchObject({exitCode:1});f.db.close();
});

it('failed checkpoint preserves historical durable files and returns an explicit error',async()=>{
  const f=fixture();const before=JSON.stringify({version:1,files:[{path:'proof.txt',data:btoa('before')}]});f.journal.save('builder',before);
  const original=f.runtime.exec;f.runtime.exec=async(...args)=>args[0].at(-1)==='pack'?process('',1):original(...args);
  const result=await f.runner.run({agent:'builder',operationId:'bad-checkpoint',command:'true'});
  expect(result).toMatchObject({checkpointed:false});expect(result.error).toContain('previous durable files retained');expect(f.journal.checkpoint('builder')).toBe(before);expect(f.effects).toContain('destroy');f.db.close();
});
it('sandbox monthly limits persist across UTC rollover and cannot be replenished by resume',()=>{
  const {sql,db}=sqlite();let now=Date.UTC(2026,9,1);const ledger=new BillingLedger(sql,()=>now);
  for(let day=0;day<3;day++){ledger.reserve({sandboxSeconds:270});now+=86400000;}
  ledger.reserve({sandboxSeconds:90});now+=86400000;
  expect(()=>ledger.reserve({sandboxSeconds:90})).toThrow('monthly');expect(ledger.status().stopped).toBe(true);
  ledger.resume();expect(()=>ledger.reserve({sandboxSeconds:90})).toThrow('monthly');db.close();
});
it('checkpoint, interrupted operation and occupied lease survive an actual SQLite close/reopen',async()=>{
  const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'hm-sandbox-restart-'));const file=join(dir,'sandbox.sqlite');
  try{
    let opened=sqlite(file);let journal=new SandboxJournal(opened.sql);const ledger=new BillingLedger(opened.sql);const lease=new SandboxLeases(opened.sql,ledger).acquire('builder','stable');
    journal.start('stable','builder','hash');journal.lease('stable',lease.token);journal.save('builder','{"version":1,"files":[]}');opened.db.close();
    opened=sqlite(file);journal=new SandboxJournal(opened.sql);
    expect(journal.incomplete()).toEqual([{id:'stable',lease:lease.token}]);expect(()=>journal.start('stable','builder','hash')).toThrow('replay denied');
    expect(new SandboxLeases(opened.sql,new BillingLedger(opened.sql)).status()?.token).toBe(lease.token);expect(journal.checkpoint('builder')).toBe('{"version":1,"files":[]}');opened.db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
it('Pi shell tool binds trusted agent identity and stable task identity, ignoring forged extra arguments',async()=>{
  const {shellExtension}=await import('../src/sandbox/extension');const bodies:any[]=[];
  const agent={projectName:()=> 'builder',billing:{assertRunning:async()=>{}},codingSandbox:{fetch:async(_url:string,init:any)=>{bodies.push(JSON.parse(init.body));return Response.json({exitCode:0,stdout:'',stderr:'',checkpointed:true});}}};
  const tool=shellExtension(agent as any).tools![0];const api={conversationId:'epoch1',taskId:'task1',callId:'model-reused-call'};const context={abortSignal:new AbortController().signal};
  const args={command:'true',agent:'reviewer',operationId:'forged'};
  await tool.execute(args,api as any,context as any);await tool.execute(args,api as any,context as any);
  await tool.execute(args,{...api,taskId:'task2'} as any,context as any);
  expect(bodies.map(body=>body.agent)).toEqual(['builder','builder','builder']);expect(bodies[0].operationId).toMatch(/^[a-f0-9]{64}$/);
  expect(bodies[0].operationId).toBe(bodies[1].operationId);expect(bodies[2].operationId).not.toBe(bodies[0].operationId);
});
it('blocks paid native activation before effects even with the previous cost confirmation',async()=>{
  const {execFileSync}=await import('node:child_process');
  for(const args of [[],['--confirm-reviewed-sandbox-costs']]){
    try{execFileSync('node_modules/.bin/tsx',['scripts/deploy-sandbox.ts',...args],{stdio:'pipe'});throw new Error('Activation unexpectedly succeeded');}
    catch(error:any){expect(error.status).toBe(1);expect(String(error.stderr)).toContain('Sandbox activation blocked');}
  }
});
