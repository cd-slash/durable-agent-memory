import { within } from './deadline';
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { durableObjectDriver } from '../storage/durable-sqlite';
import { SandboxJournal } from './journal';
import { SandboxRunner, type SandboxRuntime } from './runner';
import { SANDBOX, type ShellInput } from './policy';
import { sandboxNetwork } from './network';
import type { SandboxLease } from './leases';
interface SandboxEnv { BILLING:DurableObjectNamespace; SANDBOX_ENABLED?:string }
export class SandboxEgress extends WorkerEntrypoint<SandboxEnv,{token:string}> {
  async fetch(request:Request) {
    if (this.env.SANDBOX_ENABLED !== 'true') return new Response('Sandbox disabled',{status:503});
    return sandboxNetwork(request,async bytes=>{
      const response = await this.env.BILLING.getByName('project-global-v1').fetch('https://billing/sandbox/network',{method:'POST',body:JSON.stringify({token:this.ctx.props.token,bytes})});
      if (!response.ok) throw new Error('Network reservation denied');
    });
  }
}
/** All agents use ONE named object; per-agent checkpoints, fresh container per command. */
export class CodingSandbox extends DurableObject<SandboxEnv> {
  readonly journal = new SandboxJournal(durableObjectDriver(this.ctx.storage));
  private cleaning?:Promise<void>;
  readonly control = this.env.BILLING.getByName('project-global-v1');
  private async call(action:string,body?:unknown):Promise<any> {
    const response=await within(this.control.fetch('https://billing/sandbox/'+action,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})}));
    if (!response.ok) throw new Error('Sandbox control denied'); return response.json();
  }
  private container() { if (!this.ctx.container) throw new Error('Container attachment unavailable'); return this.ctx.container; }
  readonly runtime:SandboxRuntime = {
    acquire: input=>this.call('acquire',{agent:input.agent,operationId:input.operationId}),
    assertActive: token=>this.call('active',{token}),
    alarm: deadline=>this.ctx.storage.setAlarm(deadline),
    start: async lease=>{
      const container=this.container();
      container.start({image:container.images.coding,instance:'lite',enableInternet:false,
        entrypoint:['/bin/sleep',String(SANDBOX.containerLifetimeSeconds)],
        env:{HOME:'/tmp',PATH:'/usr/local/bin:/usr/bin:/bin',NODE_EXTRA_CA_CERTS:'/etc/cloudflare/certs/cloudflare-containers-ca.crt',GIT_SSL_CAINFO:'/etc/cloudflare/certs/cloudflare-containers-ca.crt',GIT_TERMINAL_PROMPT:'0',NPM_CONFIG_CACHE:'/tmp/npm-cache',NPM_CONFIG_FETCH_RETRIES:'0',NPM_CONFIG_FETCH_TIMEOUT:'5000',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false'},
        labels:{application:'durable-agent-memory',lease:lease.token}});
      await container.setInactivityTimeout(1000);
      // enableInternet=false also denies direct TCP/SSH, other ports and IP-address bypasses.
      const exports = this.ctx.exports as unknown as {SandboxEgress(options:{props:{token:string}}):Fetcher};
      const egress=exports.SandboxEgress({props:{token:lease.token}});
      await container.interceptAllOutboundHttp(egress);
      await container.interceptOutboundHttps('*',egress);
    },
    exec: async (command,signal,stdin,user)=>{
      signal.throwIfAborted();
      const input=stdin===undefined?undefined:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(stdin));controller.close();}});
      const process=await this.container().exec(command,{cwd:'/workspace',user,signal,stdin:input,stdout:'pipe',stderr:'pipe'});
      return process as unknown as import('./process').ShellProcess;
    },
    destroy: async()=>{await this.container().destroy();},
    release: async token=>{await this.call('release',{token});},
    failure: async()=>{await this.call('failure',{});},
    clearAlarm: ()=>this.ctx.storage.deleteAlarm(),
  };
  readonly runner = new SandboxRunner(this.journal,this.runtime);
  constructor(ctx:DurableObjectState,env:SandboxEnv) {
    super(ctx,env);
    ctx.blockConcurrencyWhile(async()=>{
      // Recovery only destroys; never restarts execution or drains queued work.
      if (this.ctx.container?.running || this.journal.incomplete().length) await this.cleanup();
    });
  }
  async cleanup() {
    if(this.cleaning)return this.cleaning;
    this.cleaning=this.performCleanup();
    try{await this.cleaning;}finally{this.cleaning=undefined;}
  }
  private async performCleanup() {
    this.runner.abort();
    try {
      await within(this.container().destroy());
      const {lease} = await this.call('status');
      if (lease) await this.call('release',{token:(lease as SandboxLease).token});
      for (const job of this.journal.incomplete()) this.journal.finish(job.id,{exitCode:1,stdout:'',stderr:'',checkpointed:false,error:'Interrupted by stop or object restart; replay denied'});
      await this.ctx.storage.deleteAlarm();
    } catch { await this.call('failure',{}).catch(()=>{}); throw new Error('Sandbox cleanup unconfirmed'); }
  }
  async alarm() { await this.cleanup().catch(()=>{}); } // single cleanup attempt, no alarm loop
  async fetch(request:Request):Promise<Response> {
    const path=new URL(request.url).pathname;
    if (path==='/status' && request.method==='GET') return Response.json({enabled:this.env.SANDBOX_ENABLED==='true',running:this.ctx.container?.running??false,...this.journal.status()});
    if (path==='/stop' && request.method==='POST') {try {await this.cleanup();return Response.json({destroyed:true});}catch{return Response.json({error:'Cleanup unconfirmed'},{status:503});}}
    if (path==='/cancel' && request.method==='POST') {
      const {agent,operationId}=await request.json() as {agent:string;operationId:string};
      this.runner.cancel(agent,operationId);return Response.json({cancellationRequested:true});
    }
    if (path!=='/run' || request.method!=='POST') return new Response('Not found',{status:404});
    if (this.cleaning) return Response.json({error:'Sandbox cleanup in progress'},{status:503});
    if (this.env.SANDBOX_ENABLED!=='true') return Response.json({error:'Sandbox activation requires separate owner cost approval'},{status:503});
    try {
      const text=await request.text(); if(new TextEncoder().encode(text).length>20000)return new Response('Payload too large',{status:413});
      return Response.json(await this.runner.run(JSON.parse(text) as ShellInput));
    } catch {return Response.json({error:'Sandbox request denied; no automatic retry'},{status:409});}
  }
}
