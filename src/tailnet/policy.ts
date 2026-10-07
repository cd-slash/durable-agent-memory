export interface TailnetTarget { name:string; host:string; ports:number[]; sshUsers?:string[] }
export type TailnetOperation = {agent:string;operationId:string;target:string;kind:'http'|'tcp'|'ssh';port:number;path?:string;tls?:boolean;user?:string};
const namePattern=/^[a-zA-Z0-9_-]{1,40}$/;
export function tailnetHost(host:unknown):host is string {
  if(typeof host!=='string')return false;
  if(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.ts\.net$/.test(host))return host.length<=253;
  const parts=host.split('.').map(Number);
  return /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)&&parts[1]>=64&&parts[1]<=127&&parts.every(n=>n>=0&&n<=255);
}
export function targetsFromJson(raw?:string):TailnetTarget[] {
  if(!raw || raw.length>4096)return [];
  const value:unknown=JSON.parse(raw);
  if(!Array.isArray(value)||value.length>8)throw new Error('Invalid tailnet allowlist');
  const names=new Set<string>();
  for(const item of value){
    if(!item || typeof item!=='object')throw new Error('Invalid target');
    const t=item as TailnetTarget;
    if(!namePattern.test(t.name)||names.has(t.name)||!tailnetHost(t.host)||!Array.isArray(t.ports)||!t.ports.length||t.ports.length>8||t.ports.some(p=>!Number.isInteger(p)||p<1||p>65535))throw new Error('Invalid target');
    if(t.sshUsers!==undefined&&(!Array.isArray(t.sshUsers)||!t.sshUsers.length||t.sshUsers.length>4||t.sshUsers.some(u=>typeof u!=='string'||!/^[_a-z][_a-z0-9-]{0,31}$/.test(u))||!t.ports.includes(22)))throw new Error('Invalid SSH users');
    names.add(t.name);
  }
  return value as TailnetTarget[];
}
export function validateTailnet(input:TailnetOperation,targets:TailnetTarget[]):TailnetTarget {
  if(!input || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.agent)||!/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId)||!['http','tcp','ssh'].includes(input.kind))throw new Error('Invalid tailnet operation');
  const target=targets.find(t=>t.name===input.target);
  if(!target || !target.ports.includes(input.port))throw new Error('Tailnet destination denied');
  if(input.kind==='ssh'){
    if(input.port!==22||!input.user||!target.sshUsers?.includes(input.user)||input.path!==undefined||input.tls!==undefined)throw new Error('SSH verification denied');
  }else if(input.kind==='http'){
    if(input.user!==undefined)throw new Error('Unexpected SSH user');
    if(typeof input.path!=='string'||input.path.length>1024||!input.path.startsWith('/')||input.path.startsWith('//')||/[\x00-\x20\x7f\\]/.test(input.path)||/%(?:0a|0d|00)/i.test(input.path)||input.path.includes('#')||(input.tls!==undefined&&typeof input.tls!=='boolean'))throw new Error('Invalid tailnet HTTP path');
  }else if(input.path!==undefined||input.tls!==undefined||input.user!==undefined)throw new Error('TCP probe does not accept HTTP arguments');
  return target;
}
