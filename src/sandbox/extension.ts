import { sha256 } from '../core/hierarchy';
import { within } from './deadline';
import type { Extension } from '@earendil-works/pi-durable';
import type { MemoryAgent } from '../agent';
import type { ShellResult } from './policy';
export function shellExtension(agent:MemoryAgent):Extension {
  return {
    name:'cloudflare-coding-sandbox-v1',
    sections:[{key:'linux-sandbox',tag:false,render:()=> 'shell runs POSIX shell commands in a private Cloudflare Linux workspace with Node/npm, Python and Git. This /workspace is separate from the JavaScript exec/read/write VFS: use shell for ALL Linux file operations. Source and Git metadata are checkpointed only after completed commands under strict size limits; node_modules, .cache, .venv and __pycache__ are ephemeral. Combine install/build/test in one command. Public npm downloads and read-only public GitHub clones are restricted; no SSH/private repository credentials. No background servers survive a command. One container globally, at most 30 seconds per command. Inspect exitCode and checkpointed; never claim effects after errors. Collaboration happens through team tools, not a shared filesystem.'}],
    tools:[{
      name:'shell',
      description:'Execute a bounded POSIX shell command in Cloudflare Linux, cwd /workspace. Node/npm, Python3 and Git installed. Distinct from exec (JavaScript only) and VFS tools. Default 20s, max 30s, 8KiB combined output; 2MiB durable source checkpoint. Failed/aborted jobs are not automatically retried.',
      parameters:{type:'object',additionalProperties:false,properties:{command:{type:'string',maxLength:16384},timeoutMs:{type:'integer',minimum:1,maximum:30000}},required:['command']},
      replay:'unsafe',
      async execute(args,api,context) {
        await agent.billing.assertRunning();
        if (context.abortSignal?.aborted) return {isError:true,content:[{type:'text',text:'Shell cancelled before admission'}]};
        const body=args as {command:string;timeoutMs?:number};
        // Pi task identity disambiguates model-reused call ids across turns/cache epochs.
        // Coordinator admits only the agent's stored identity/tool policy.
        const operationId=await sha256(JSON.stringify([String(api.conversationId),String(api.taskId),api.callId]));
        const input={agent:agent.projectName(),operationId,command:body.command,...(body.timeoutMs===undefined?{}:{timeoutMs:body.timeoutMs})};
        let cancelling:Promise<unknown>|undefined;
        const cancel=()=>{cancelling=within(agent.codingSandbox!.fetch('https://sandbox/cancel',{method:'POST',body:JSON.stringify({agent:input.agent,operationId:input.operationId})})).catch(()=>{});};
        context.abortSignal?.addEventListener('abort',cancel,{once:true});
        try {
          const response=await within(agent.codingSandbox!.fetch('https://sandbox/run',{method:'POST',body:JSON.stringify(input)}),105000);
          const result=await response.json() as ShellResult;
          return {isError:!response.ok || result.exitCode!==0 || !result.checkpointed,content:[{type:'text',text:JSON.stringify(result)}]};
        } finally {context.abortSignal?.removeEventListener('abort',cancel);await cancelling;}
      },
    }],
  };
}
