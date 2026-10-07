import { SANDBOX } from './policy';
/** Public package downloads and read-only public Git smart HTTP only. No redirects/auth. */
export function allowedSandboxRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || request.headers.has('authorization') || request.headers.has('cookie')) return false;
  if (url.hostname === 'registry.npmjs.org') return request.method === 'GET' && !url.search;
  if (url.hostname !== 'github.com' || !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\.git\/(info\/refs|git-upload-pack)$/.test(url.pathname)) return false;
  return (request.method === 'GET' && url.pathname.endsWith('/info/refs') && url.search === '?service=git-upload-pack')
    || (request.method === 'POST' && url.pathname.endsWith('/git-upload-pack') && !url.search);
}
export async function cappedBody(stream: ReadableStream<Uint8Array> | null, cap: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort',abort,{once:true});
  try {
    if (signal?.aborted) throw new Error('Network interrupted');
    while (true) {
      const {done,value} = await reader.read();
      if (signal?.aborted) throw new Error('Network interrupted');
      if (done) break; size += value.byteLength;
      if (size > cap) throw new Error('Network byte limit exceeded');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    return bytes;
  } finally { signal?.removeEventListener('abort',abort); void reader.cancel().catch(() => {}); }
}
export async function sandboxNetwork(request: Request, reserve: (bytes:number)=>Promise<void>, outbound: typeof fetch = fetch) {
  if (!allowedSandboxRequest(request)) return new Response('Sandbox destination or method denied', {status:403});
  const signal = AbortSignal.timeout(5000);
  try {
    const body = await cappedBody(request.body as ReadableStream<Uint8Array>|null,SANDBOX.requestBytes,signal);
    await reserve(body.length);
    const response = await outbound(request.url, { method:request.method, headers:{'user-agent':'durable-agent-memory-sandbox','accept':request.headers.get('accept') ?? '*/*',...(body.length?{'content-type':request.headers.get('content-type') ?? 'application/octet-stream'}:{})}, ...(body.length?{body:body.buffer as ArrayBuffer}:{}), redirect:'manual', signal });
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel(); return new Response('Sandbox redirects denied',{status:403}); }
    const data = await cappedBody(response.body as ReadableStream<Uint8Array>|null,SANDBOX.responseBytes,signal);
    // Deliberately discard cookies, credentials, redirect and arbitrary response headers.
    return new Response(data.buffer as ArrayBuffer,{status:response.status,headers:{'content-type':response.headers.get('content-type') ?? 'application/octet-stream'}});
  } catch { return new Response('Sandbox network denied, timed out or exceeded limit',{status:503}); }
}
