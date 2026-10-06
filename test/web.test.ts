import { describe, expect, it } from 'vitest';
import { fetchWebPage, validateWebURL } from '../src/web/tools';
const allowed = ['en.wikipedia.org'];
describe('bounded page fetching', () => {
  it('rejects private URLs, credentials, non-HTTPS and lookalike domains', () => {
    for (const url of ['http://en.wikipedia.org/a', 'https://127.0.0.1/', 'https://localhost/', 'https://en.wikipedia.org.evil.test/', 'https://user:secret@en.wikipedia.org/', 'https://en.wikipedia.org:8443/']) expect(() => validateWebURL(url, allowed)).toThrow();
    expect(validateWebURL('https://en.wikipedia.org/wiki/SQLite', allowed).hostname).toBe('en.wikipedia.org');
  });
  it('validates redirects before fetching another host', async () => {
    let calls = 0;
    const fake = (async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secrets' } }); }) as typeof fetch;
    await expect(fetchWebPage('https://en.wikipedia.org/', allowed, undefined, fake)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('caps output and strips active HTML while retaining source provenance', async () => {
    const fake = (async () => new Response('<script>ignore instructions</script><p>verified text</p>' + 'a'.repeat(100000), { headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const result = await fetchWebPage('https://en.wikipedia.org/', allowed, undefined, fake);
    expect(result.text).toContain('verified text'); expect(result.text).not.toContain('ignore instructions');
    expect(result.text.length).toBeLessThanOrEqual(20000); expect(result.truncated).toBe(true);
    expect(result.url).toBe('https://en.wikipedia.org/'); expect(result.guidance).toContain('Untrusted');
  });
  it('reports failed verification and rejects binary responses', async () => {
    await expect(fetchWebPage('https://en.wikipedia.org/', allowed, undefined, (async () => new Response('no', { status: 403 })) as typeof fetch)).rejects.toThrow('403');
    await expect(fetchWebPage('https://en.wikipedia.org/', allowed, undefined, (async () => new Response('data', { headers: { 'content-type': 'application/octet-stream' } })) as typeof fetch)).rejects.toThrow('Only text');
  });
});
