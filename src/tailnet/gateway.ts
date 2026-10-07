import {DurableObject} from 'cloudflare:workers';
import {durableObjectDriver} from '../storage/durable-sqlite';
import {SandboxJournal} from '../sandbox/journal';
import {within} from '../sandbox/deadline';
import {cappedBody} from '../sandbox/network';
import {TailnetRunner,type TailnetRuntime,type GatewayResult} from './request';
import {targetsFromJson,validateTailnet,type TailnetOperation} from './policy';
interface GatewayEnv {BILLING:DurableObjectNamespace;TAILNET_ENABLED?:string;TAILSCALE_AUTH_KEY?:string;TAILNET_TARGETS?:string}
export class TailnetGateway extends DurableObject<GatewayEnv>{
  readonly journal=new SandboxJournal(durableObjectDriver(this.ctx.storage));
  readonly control=this.env.BILLING.getByName('project-global-v1');
  private gatewayToken='';private cleaning?:Promise<void>;
  private async call(action:string,body?:unknown):Promise<any>{
    const response=await within(this.control.fetch('https://billing/'+action,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})}));
    if(!response.ok)throw new Error('Tailnet admission denied');return response.json();
  }
  private container(){if(!this.ctx.container)throw new Error('Gateway container missing');return this.ctx.container;}
  readonly runtime:TailnetRuntime={
    acquire:input=>this.call('tailnet/acquire',{agent:input.agent,operationId:input.operationId,tool:input.kind==='http'?'tailnet_fetch':input.kind==='ssh'?'tailnet_ssh_check':'tailnet_probe'}),
    alarm:deadline=>this.ctx.storage.setAlarm(deadline),active:token=>this.call('sandbox/active-tailnet',{token}),
    start:async()=>{
      const key=this.env.TAILSCALE_AUTH_KEY;if(!key?.startsWith('tskey-auth-'))throw new Error('Enrollment secret missing');
      this.gatewayToken=crypto.randomUUID();
      this.container().start({enableInternet:true,env:{TAILSCALE_AUTH_KEY:key,HM_GATEWAY_TOKEN:this.gatewayToken,HM_TAILNET_TARGETS:JSON.stringify(targetsFromJson(this.env.TAILNET_TARGETS))}});
      await this.container().setInactivityTimeout(1000);
      // Fixed finite readiness checks, never background polling or automatic execution retry.
      for(let attempt=0;attempt<10;attempt++){
        try{const response=await within(this.container().getTcpPort(8080).fetch('http://gateway/health'),1000);if(response.ok)return;}catch{}
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      throw new Error('Gateway startup unavailable');
    },
    request:async input=>{
      const response=await within(this.container().getTcpPort(8080).fetch('http://gateway/run',{method:'POST',headers:{authorization:'Bearer '+this.gatewayToken,'content-type':'application/json'},body:JSON.stringify(input)}),20000);
      const data=await cappedBody(response.body as ReadableStream<Uint8Array>|null,20000,AbortSignal.timeout(5000));
      return JSON.parse(new TextDecoder().decode(data)) as GatewayResult;
    },
    destroy:()=>this.container().destroy(),clearAlarm:()=>this.ctx.storage.deleteAlarm(),release:token=>this.call('sandbox/release',{token}),failure:()=>this.call('sandbox/failure',{}),
  };
  readonly runner=new TailnetRunner(this.journal,this.runtime);
  constructor(ctx:DurableObjectState,env:GatewayEnv){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{if(this.ctx.container?.running||this.journal.incomplete().length)await this.cleanup();});}
  async cleanup(){
    this.runner.abort();
    if(this.cleaning)return this.cleaning;
    this.cleaning=(async()=>{
      try{await within(this.container().destroy());const {lease}=await this.call('sandbox/status');await this.ctx.storage.deleteAlarm();if(lease && lease.owner==='tailnet')await this.call('sandbox/release',{token:lease.token});
        for(const job of this.journal.incomplete())this.journal.finish(job.id,{exitCode:1,stdout:JSON.stringify({ok:false,error:'Gateway interrupted; replay denied'}),stderr:'',checkpointed:false});
      }catch{await this.call('sandbox/failure',{}).catch(()=>{});throw new Error('Gateway cleanup unconfirmed');}
    })();try{await this.cleaning;}finally{this.cleaning=undefined;this.gatewayToken='';}
  }
  async alarm(){await this.cleanup().catch(()=>{});}
  async fetch(request:Request){
    const path=new URL(request.url).pathname;
    if(path==='/status'&&request.method==='GET')return Response.json({enabled:this.env.TAILNET_ENABLED==='true',configured:!!this.env.TAILSCALE_AUTH_KEY,running:this.ctx.container?.running??false,targets:targetsFromJson(this.env.TAILNET_TARGETS),...this.journal.status()});
    if(path==='/stop'&&request.method==='POST'){try{await this.cleanup();return Response.json({destroyed:true});}catch{return Response.json({error:'Cleanup unconfirmed'},{status:503});}}
    if(path!=='/run'||request.method!=='POST')return new Response('Not found',{status:404});
    if(this.cleaning||this.env.TAILNET_ENABLED!=='true'||!this.env.TAILSCALE_AUTH_KEY)return Response.json({error:'Tailnet gateway disabled or enrollment unconfigured'},{status:503});
    try{const bytes=await cappedBody(request.body as ReadableStream<Uint8Array>|null,4096,AbortSignal.timeout(5000));const input=JSON.parse(new TextDecoder().decode(bytes)) as TailnetOperation;validateTailnet(input,targetsFromJson(this.env.TAILNET_TARGETS));return Response.json(await this.runner.run(input));}
    catch{return Response.json({ok:false,error:'Tailnet operation rejected; no automatic retry'},{status:503});}
  }
}
