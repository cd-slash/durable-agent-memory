import type {TailnetOperation} from './policy';
import {SANDBOX} from '../sandbox/policy';
import {SandboxJournal} from '../sandbox/journal';
import {sha256} from '../core/hierarchy';
import {within,interruptible} from '../sandbox/deadline';
export interface GatewayResult { ok:boolean; status?:number;body?:string;bodyBase64?:string;banner?:string;error?:string }
export interface TailnetRuntime {
  acquire(input:TailnetOperation):Promise<{token:string;deadline:number}>;
  alarm(deadline:number):Promise<void>;
  active(token:string):Promise<void>;
  start(token:string):Promise<void>;
  request(input:TailnetOperation):Promise<GatewayResult>;
  destroy():Promise<void>;clearAlarm():Promise<void>;release(token:string):Promise<void>;failure():Promise<void>;
}
/** One admitted operation per trusted gateway lifetime; no arbitrary command execution. */
export class TailnetRunner {
  private busy=false;private controller?:AbortController;
  abort(){this.controller?.abort();}
  constructor(private journal:SandboxJournal,private runtime:TailnetRuntime){}
  async run(input:TailnetOperation):Promise<GatewayResult>{
    if(this.busy)throw new Error('Tailnet gateway busy');this.busy=true;const controller=new AbortController();this.controller=controller;
    let lease:{token:string;deadline:number}|undefined,id:string|undefined,admitting=false,phase='journal';
    let result:GatewayResult={ok:false,error:'Tailnet operation denied or interrupted'};
    try{
      id=await sha256('tailnet\0'+input.agent+'\0'+input.operationId);
      const prior=this.journal.start(id,input.agent,await sha256(JSON.stringify(input)));
      if(prior)return JSON.parse(prior.stdout) as GatewayResult;
      phase='admission';admitting=true;lease=await within(this.runtime.acquire(input));this.journal.lease(id,lease.token);
      const work=async()=>{
        phase='lease';await interruptible(this.runtime.alarm(lease!.deadline),controller.signal);await interruptible(this.runtime.active(lease!.token),controller.signal);
        if(controller.signal.aborted)throw new Error("Gateway interrupted");
        phase='startup';await interruptible(this.runtime.start(lease!.token),controller.signal);
        await interruptible(this.runtime.active(lease!.token),controller.signal);
        if(controller.signal.aborted)throw new Error("Gateway interrupted");
        phase='request';const response=await within(this.runtime.request(input),20000);
        if(new TextEncoder().encode(JSON.stringify(response)).length>SANDBOX.outputBytes*2)throw new Error('Gateway result too large');
        return response;
      };
      result=await within(interruptible(work(),controller.signal),Math.max(1,lease.deadline-Date.now()));
    }catch{result={ok:false,error:'Tailnet operation denied or interrupted during '+phase};/* Never echo provider output/credentials. */}
    finally{
      controller.abort();
      if(lease)try{await within(this.runtime.destroy());await within(this.runtime.clearAlarm());await within(this.runtime.release(lease.token));}catch{await within(this.runtime.failure()).catch(()=>{});result={ok:false,error:'Gateway cleanup unconfirmed; billing stop requested'};}
      if(admitting&&!lease)await within(this.runtime.failure()).catch(()=>{});
      if(id&&this.journal.incomplete().some(job=>job.id===id))this.journal.finish(id,{exitCode:result.ok?0:1,stdout:JSON.stringify(result),stderr:'',checkpointed:false});
      this.busy=false;this.controller=undefined;
    }
    return result;
  }
}
