import type { Env } from './agent';
import { debugUI } from './ui';
export { MemoryAgent } from './agent';
export { BillingControl } from './billing/control';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, runtime: 'PiHarness', storage: 'SQLite Durable Object', localTest: env.LOCAL_TEST === 'true' });
    if (url.pathname === '/') return new Response(debugUI, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' } });
    if (!env.DEMO_TOKEN) return Response.json({ error: 'Set DEMO_TOKEN with wrangler secret put DEMO_TOKEN before using the demo API' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${env.DEMO_TOKEN}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const control = env.BILLING.get(env.BILLING.idFromName('project-global-v1'));
    if (/^\/admin\/billing\/(status|stop|resume)$/.test(url.pathname)) {
      const action = url.pathname.split('/').at(-1)!;
      if ((action === 'status' && request.method !== 'GET') || (action !== 'status' && request.method !== 'POST')) return new Response('Method not allowed', { status: 405 });
      const body = action === 'resume' ? await request.text() : undefined;
      if (body && body.length > 200) return new Response('Payload too large', { status: 413 });
      return control.fetch('https://billing/' + action, { method: request.method, ...(body ? { body } : {}) });
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
    return env.AGENTS.get(env.AGENTS.idFromName(match[1])).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
