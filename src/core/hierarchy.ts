/** Completed dyadic ranges only; leaf summaries are level zero. Positions are namespace-local. */
export function completedRanges(count: number): Array<{ start: number; end: number; level: number }> {
  const ranges = [];
  for (let level = 0, size = 1; size <= count; level++, size *= 2) {
    for (let start = 0; start + size <= count; start += size) {
      ranges.push({ start, end: start + size - 1, level });
    }
  }
  return ranges;
}
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function canonical(value: unknown): string {
  if (value === undefined) throw new Error('Undefined is not JSON metadata');
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite metadata');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Metadata must be JSON');
    return encoded;
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
}
