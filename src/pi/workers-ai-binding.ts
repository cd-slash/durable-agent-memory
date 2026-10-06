/**
 * Agents' Pi provider expects Response when it requests returnRawResponse.
 * Workers AI can return JSON or a ReadableStream on model-specific paths.
 * Normalize that public binding boundary without changing Pi or its transcript.
 */
export function normalizeRawAIResponse(value: unknown): Response {
  if (value instanceof Response) return value;
  if (value instanceof ReadableStream) return new Response(value, { headers: { 'content-type': 'text/event-stream' } });
  if (value !== null && typeof value === 'object') return Response.json(value);
  throw new Error('Workers AI returned an invalid raw response');
}
export function piAIBinding(binding: Ai): Ai {
  return new Proxy(binding, {
    get(target, key) {
      if (key === 'run') return async (...args: unknown[]) => {
        const value: unknown = await Reflect.apply(target.run, target, args);
        const options = args[2] as { returnRawResponse?: boolean } | undefined;
        if (!options?.returnRawResponse) return value;
        if (!(value instanceof Response)) console.warn('hm_ai_response_normalized', { shape: value instanceof ReadableStream ? 'stream' : 'json' });
        return normalizeRawAIResponse(value);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
