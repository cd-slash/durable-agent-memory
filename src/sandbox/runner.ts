import { interruptible, within } from './deadline';
import type { SandboxJournal } from './journal';
import { SANDBOX, validateShell, type ShellInput, type ShellResult } from './policy';
import type { SandboxLease } from './leases';
import { boundedProcess, type ShellProcess } from './process';
import { sha256 } from '../core/hierarchy';
export interface SandboxRuntime {
  acquire(input:ShellInput):Promise<SandboxLease>;
  assertActive(token:string):Promise<void>;
  alarm(deadline:number):Promise<void>;
  start(lease:SandboxLease):Promise<void>;
  exec(command:string[],signal:AbortSignal,stdin?:string,user?:string):Promise<ShellProcess>;
  destroy():Promise<void>;
  release(token:string):Promise<void>;
  failure():Promise<void>;
  clearAlarm():Promise<void>;
}
/** Single-flight, durable unsafe-replay journal; all effects occur after central reservation. */
export class SandboxRunner {
  private active?:AbortController;
  private activeInput?:ShellInput;
  constructor(private journal:SandboxJournal,private runtime:SandboxRuntime) {}
  abort() { this.active?.abort(); }
  cancel(agent:string,operationId:string) { if(this.activeInput?.agent===agent && this.activeInput.operationId===operationId) this.abort(); }
  async run(input:ShellInput):Promise<ShellResult> {
    validateShell(input);
    if (this.active) throw new Error('Sandbox busy; no automatic retry');
    const controller = new AbortController(); this.active = controller; this.activeInput=input;
    let lease:SandboxLease|undefined, jobId:string|undefined, admitting=false, timer:ReturnType<typeof setTimeout>|undefined;
    let result:ShellResult = {exitCode:1,stdout:'',stderr:'',checkpointed:false,error:'Sandbox failed'};
    try {
      jobId = await sha256(input.agent + '\0' + input.operationId);
      const hash = await sha256(JSON.stringify([input.command,input.timeoutMs ?? SANDBOX.commandMs]));
      const cached = this.journal.start(jobId,input.agent,hash); if (cached) return cached;
      admitting=true; lease = await within(this.runtime.acquire(input)); this.journal.lease(jobId,lease.token);
      timer = setTimeout(()=>controller.abort(),Math.max(1,lease.deadline-Date.now()));
      const work = async () => {
        await this.runtime.alarm(lease!.deadline);
        await this.runtime.assertActive(lease!.token);
        controller.signal.throwIfAborted();
        await this.runtime.start(lease!);
        const execute = async (cmd:string[],cap:number,stdin?:string,user='root',signal=controller.signal) => {
          signal.throwIfAborted();
          const launching = this.runtime.exec(cmd,signal,stdin,user).then(process=>{if(signal.aborted){try{process.kill(9);}catch{}}return process;});
          const process = await interruptible(launching,signal);
          return boundedProcess(process,cap,signal);
        };
        const restore = await execute(['python3','/opt/hm/checkpoint.py','restore'],SANDBOX.outputBytes,this.journal.checkpoint(input.agent));
        if (restore.exitCode !== 0) throw new Error('Checkpoint restore failed');
        const commandSignal = AbortSignal.any([controller.signal,AbortSignal.timeout(input.timeoutMs ?? SANDBOX.commandMs)]);
        const command = await execute(['/bin/sh','-c',input.command],SANDBOX.outputBytes,undefined,'1000',commandSignal);
        // No checkpoint if command timed out/overflowed. Nonzero completed commands may have useful file effects.
        const checkpoint = await execute(['python3','/opt/hm/checkpoint.py','pack'],SANDBOX.checkpointWireBytes);
        controller.signal.throwIfAborted();
        if (checkpoint.exitCode !== 0) return {...command,checkpointed:false,error:'Workspace checkpoint rejected; previous durable files retained. Changes from this command will be discarded.'};
        this.journal.save(input.agent,checkpoint.stdout);
        return {...command,checkpointed:true};
      };
      // Native startup/exec can stall before returning a process; deadline still breaks the wait.
      let cancel:()=>void = ()=>{};
      const interrupted = new Promise<never>((_,reject)=>{cancel=()=>reject(new Error('Sandbox deadline or emergency cancellation'));controller.signal.addEventListener('abort',cancel,{once:true});if(controller.signal.aborted)cancel();});
      try { result = await Promise.race([work(),interrupted]); }
      finally {controller.signal.removeEventListener('abort',cancel);}
    } catch {
      // Avoid logging or echoing command/secret content in infrastructure errors.
      result = {exitCode:1,stdout:'',stderr:'',checkpointed:false,error:'Sandbox denied, interrupted or exceeded a runtime/output limit; no automatic retry. Inspect owner sandbox/billing status.'};
    } finally {
      if (timer) clearTimeout(timer);
      if (lease) {
        try {
          await within(this.runtime.destroy());
          await within(this.runtime.clearAlarm());
          await within(this.runtime.release(lease.token));
        } catch {
          await within(this.runtime.failure()).catch(()=>{});
          result = {...result,exitCode:1,error:'Container cleanup unconfirmed; global slot retained and billing stop requested'};
        }
      }
      if (admitting && !lease) await within(this.runtime.failure()).catch(()=>{});
      if (jobId) {
        // Never replace completed replay evidence with a later failure.
        const pending = this.journal.incomplete().some(job=>job.id===jobId);
        if (pending) this.journal.finish(jobId,result);
      }
      this.active=undefined; this.activeInput=undefined;
    }
    return result;
  }
}
