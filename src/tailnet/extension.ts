import type {Extension} from '@earendil-works/pi-durable';
import type {MemoryAgent} from '../agent';
import {sha256} from '../core/hierarchy';
import {within} from '../sandbox/deadline';
import {targetsFromJson,validateTailnet,type TailnetOperation} from './policy';
import type {GatewayResult} from './request';
export function tailnetExtension(agent:MemoryAgent):Extension {
  const targets=targetsFromJson(agent.tailnetTargets());
  return {name:'bounded-tailnet-gateway-v1',sections:[{key:'tailnet-capabilities',tag:false,render:()=> 'tailnet_fetch performs HTTP GET and tailnet_ssh_check verifies SSH with a fixed marker/id command and tailnet_probe verifies TCP connectivity to owner-approved private servers/ports through a separate trusted gateway. No enrollment key, general SOCKS proxy or SSH login credential is provided to agent code. Approved targets: '+JSON.stringify(targets)}],tools:['http','tcp','ssh'].map(kind=>({
    name:kind==='http'?'tailnet_fetch':kind==='ssh'?'tailnet_ssh_check':'tailnet_probe',
    description:kind==='ssh'?'Verify Tailscale SSH login to an approved server/user with a fixed read-only marker and id command. No custom commands.':kind==='http'?'Read an approved Tailscale server using bounded HTTP GET. No redirects, uploads, custom auth headers or arbitrary URLs.':'Probe an approved Tailscale server TCP port; returns a short banner if available. This is connectivity, not authenticated SSH execution.',
    parameters:{type:'object',additionalProperties:false,properties:{target:{type:'string'},port:{type:'integer',minimum:1,maximum:65535},...(kind==='http'?{path:{type:'string',maxLength:1024},tls:{type:'boolean'}}:kind==='ssh'?{user:{type:'string'}}:{})},required:kind==='http'?['target','port','path']:kind==='ssh'?['target','port','user']:['target','port']},
    replay:'unsafe' as const,
    async execute(args,api,context){
      await agent.billing.assertRunning();if(context.abortSignal?.aborted)throw new Error('Tailnet request cancelled');
      const body=args as {target:string;port:number;path?:string;tls?:boolean;user?:string};
      const input:TailnetOperation={agent:agent.projectName(),operationId:await sha256(JSON.stringify([String(api.conversationId),String(api.taskId),api.callId])),target:body.target,port:body.port,kind:kind as 'http'|'tcp'|'ssh',...(kind==='http'?{path:body.path,tls:body.tls}:kind==='ssh'?{user:body.user}:{})};
      validateTailnet(input,targets);
      const response=await within(agent.tailnetGateway!.fetch('https://gateway/run',{method:'POST',body:JSON.stringify(input)}),105000);
      const result=await response.json() as GatewayResult;
      if(result.bodyBase64){result.body=new TextDecoder().decode(Uint8Array.from(atob(result.bodyBase64),c=>c.charCodeAt(0))).slice(0,8192);delete result.bodyBase64;}
      return {isError:!response.ok||!result.ok,content:[{type:'text',text:JSON.stringify(result)}]};
    },
  }))};
}
