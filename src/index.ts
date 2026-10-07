import { targetsFromJson, validateTailnet, type TailnetOperation } from './tailnet/policy';
import { cappedBody } from './sandbox/network';
import { validateShell, type ShellInput } from './sandbox/policy';
import { within } from './sandbox/deadline';
import { verifyCredential } from './multiplayer/credentials';
import { multiplayerUI } from './multiplayer/ui';
import type { Env } from './agent';
import { sha256 } from './core/hierarchy';
import { projectRoutes, teamCall } from './multiplayer/routes';
import { debugUI } from './ui';
export { MemoryAgent } from './agent';
export { BillingControl } from './billing/control';
export { TailnetGateway } from './tailnet/gateway';
export { CodingSandbox, SandboxEgress } from './sandbox/container';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, runtime: 'PiHarness', storage: 'SQLite Durable Object', localTest: env.LOCAL_TEST === 'true' });
    if (url.pathname === '/' || url.pathname === '/multiplayer') return new Response(url.pathname === '/' ? debugUI : multiplayerUI, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' } });
    if (!env.DEMO_TOKEN) return Response.json({ error: 'Set DEMO_TOKEN with wrangler secret put DEMO_TOKEN before using the demo API' }, { status: 503 });
    const credential = request.headers.get('authorization')?.match(/^Bearer (.{1,256})$/)?.[1];
    if (!credential) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const owner = credential === env.DEMO_TOKEN;
    if (!owner && !await verifyCredential(credential, env.DEMO_TOKEN)) return Response.json({error:'Unauthorized'},{status:401});
    let member = 'owner';
    const hash = owner ? '' : await sha256(credential);
    const control = env.BILLING.get(env.BILLING.idFromName('project-global-v1'));
    const projectResponse = await projectRoutes(request, env, control, owner, hash);
    if (projectResponse) return projectResponse;
    if (/^\/admin\/billing\/(status|stop|resume|sessions|inspect)$/.test(url.pathname)) {
      if (!owner) return Response.json({ error: 'Owner access required' }, { status: 403 });
      const action = url.pathname.split('/').at(-1)!;
      if ((['status','sessions','inspect'].includes(action) && request.method !== 'GET') || (!['status','sessions','inspect'].includes(action) && request.method !== 'POST')) return new Response('Method not allowed', { status: 405 });
      const body = action === 'resume' ? await request.text() : undefined;
      if (body && body.length > 200) return new Response('Payload too large', { status: 413 });
      return control.fetch('https://billing/' + action + (action === 'inspect' ? url.search : ''), { method: request.method, ...(body ? { body } : {}) });
    }
    if (url.pathname === '/admin/sandbox/status') {
      if (!owner) return Response.json({error:'Owner access required'},{status:403});
      if (request.method !== 'GET') return new Response('Method not allowed',{status:405});
      if (!env.SANDBOX) return Response.json({enabled:false,message:'Container infrastructure has not been activated'});
      return env.SANDBOX.getByName('project-coding-v1').fetch('https://sandbox/status');
    }
    if (url.pathname === '/admin/sandbox/run') {
      if (!owner) return Response.json({error:'Owner access required'},{status:403});
      if (request.method !== 'POST') return new Response('Method not allowed',{status:405});
      if (!env.SANDBOX || env.SANDBOX_ENABLED !== 'true') return Response.json({error:'Sandbox not activated'},{status:503});
      try {
        const bytes = await cappedBody(request.body as ReadableStream<Uint8Array>|null,20000,AbortSignal.timeout(5000));
        const input = JSON.parse(new TextDecoder().decode(bytes)) as ShellInput;
        validateShell(input);
        const permit = await control.fetch('https://billing/reserve',{method:'POST',body:JSON.stringify({requests:1,storageBytes:4096+bytes.length*16})});
        if (!permit.ok) return Response.json({error:'Billing stop or request/storage quota reached'},{status:503});
        const admitted = await control.fetch('https://billing/agent',{method:'POST',body:JSON.stringify({agent:input.agent})});
        if (!admitted.ok) return admitted;
        return await within(env.SANDBOX.getByName('project-coding-v1').fetch('https://sandbox/run',{method:'POST',body:JSON.stringify(input)}),105000);
      } catch { return Response.json({error:'Sandbox request invalid, interrupted or denied; no automatic retry'},{status:503}); }
    }
    if(url.pathname==='/admin/tailnet/status') {
      if(!owner)return Response.json({error:'Owner access required'},{status:403});
      if(request.method!=='GET')return new Response('Method not allowed',{status:405});
      if(!env.TAILNET)return Response.json({enabled:false,configured:!!env.TAILSCALE_AUTH_KEY});
      return env.TAILNET.getByName('project-tailnet-v1').fetch('https://gateway/status');
    }
    if(url.pathname==='/admin/tailnet/run') {
      if(!owner)return Response.json({error:'Owner access required'},{status:403});
      if(request.method!=='POST')return new Response('Method not allowed',{status:405});
      if(!env.TAILNET||env.TAILNET_ENABLED!=='true'||!env.TAILSCALE_AUTH_KEY)return Response.json({ok:false,error:'Tailnet gateway not activated or enrolled'},{status:503});
      try {
        const bytes=await cappedBody(request.body as ReadableStream<Uint8Array>|null,4096,AbortSignal.timeout(5000));
        const input=JSON.parse(new TextDecoder().decode(bytes)) as TailnetOperation;
        validateTailnet(input,targetsFromJson(env.TAILNET_TARGETS));
        const permit=await control.fetch('https://billing/reserve',{method:'POST',body:JSON.stringify({requests:1,storageBytes:4096+bytes.length*16})});
        if(!permit.ok)return Response.json({ok:false,error:'Billing stop or quota reached'},{status:503});
        const admitted=await control.fetch('https://billing/agent',{method:'POST',body:JSON.stringify({agent:input.agent})});if(!admitted.ok)return admitted;
        return await within(env.TAILNET.getByName('project-tailnet-v1').fetch('https://gateway/run',{method:'POST',body:JSON.stringify(input)}),105000);
      }catch{return Response.json({ok:false,error:'Tailnet request denied or interrupted'},{status:503});}
    }
    const agentMatch = url.pathname.match(/^\/api\/([a-zA-Z0-9_-]{1,64})\//);
    if (!owner) {
      if (!agentMatch) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const access = await teamCall(control, 'agent-auth', {agent:agentMatch[1],hash});
      if (!access.ok) return access;
      const actor = await access.json() as {role:string;member:string};
      member = actor.member;
      if (actor.role === 'viewer' && request.method !== 'GET') {
        if (!url.pathname.endsWith('/rpc')) return Response.json({error:'Project is read only'},{status:403});
        const payload = await request.clone().text();
        if (payload.length > 1000) return new Response('Payload too large',{status:413});
        let type: unknown; try { type=JSON.parse(payload).type; } catch { return new Response('Invalid JSON',{status:400}); }
        if (!['get_state','get_available_models','get_commands','get_messages','get_entries','get_session_stats'].includes(String(type))) return Response.json({error:'Project is read only'},{status:403});
      }
    }
    // Reserve before resolving any agent: arbitrary agent names cannot multiply quotas.
    const permit = await control.fetch('https://billing/reserve', { method: 'POST', body: JSON.stringify({ requests: 1, storageBytes: 4096 }) });
    if (!permit.ok) return Response.json({ error: 'Billing safety stop is active; inspect /admin/billing/status' }, { status: 503 });
    const match = url.pathname.match(/^\/api\/([a-zA-Z0-9_-]{1,64})(\/(?:chat|remember|search|context|read|expand|compact|reset|debug|rpc|submit|events))$/);
    if (!match) return new Response('Not found', { status: 404 });
    const admitted = await control.fetch('https://billing/agent', { method: 'POST', body: JSON.stringify({ agent: match[1] }) });
    if (!admitted.ok) return Response.json({ error: 'Global agent quota or billing stop reached' }, { status: 503 });
    if (Number(request.headers.get('content-length') ?? 0) > 150000) return new Response('Payload too large', { status: 413 });
    if (request.method === 'POST') {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > 150000) return new Response('Payload too large', { status: 413 });
      const writePermit = await control.fetch('https://billing/reserve', { method: 'POST', body: JSON.stringify({ storageBytes: Math.max(1, new TextEncoder().encode(text).length * 16) }) });
      if (!writePermit.ok) return Response.json({ error: 'Storage safety budget reached' }, { status: 503 });
      request = new Request(request, { body: text });
    }
    if (request.method === 'POST' && ['/chat', '/submit'].includes(match[2])) {
      const turn = await control.fetch('https://billing/turn', { method: 'POST', body: JSON.stringify({ agent: match[1] }) });
      if (!turn.ok) return Response.json({ error: 'Turn quota or billing safety stop reached' }, { status: 503 });
    }
    url.pathname = match[2];
    const forwarded = new Request(url, request);
    forwarded.headers.set('x-hm-agent', match[1]);
    forwarded.headers.set('x-hm-member', member);
    return env.AGENTS.get(env.AGENTS.idFromName(match[1])).fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;
