import type { Env } from './agent';
import { debugUI } from './ui';
export { MemoryAgent } from './agent';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, runtime: 'PiHarness', storage: 'SQLite Durable Object', localTest: env.LOCAL_TEST === 'true' });
    if (url.pathname === '/') return new Response(debugUI, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' } });
    if (!env.DEMO_TOKEN) return Response.json({ error: 'Set DEMO_TOKEN with wrangler secret put DEMO_TOKEN before using the demo API' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${env.DEMO_TOKEN}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const match = url.pathname.match(/^\/api\/([a-zA-Z0-9_-]{1,64})(\/(?:chat|remember|search|context|read|expand|compact|reset|debug|rpc|submit|events))$/);
    if (!match) return new Response('Not found', { status: 404 });
    if (Number(request.headers.get('content-length') ?? 0) > 150000) return new Response('Payload too large', { status: 413 });
    if (request.method === 'POST') {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > 150000) return new Response('Payload too large', { status: 413 });
      request = new Request(request, { body: text });
    }
    url.pathname = match[2];
    return env.AGENTS.get(env.AGENTS.idFromName(match[1])).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
