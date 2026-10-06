import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import type { HybridMemory } from '../core/memory';
import { memoryKinds } from '../core/types';
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
export function memoryTools(memory: HybridMemory, enqueue: () => Promise<void>): ToolRegistration[] {
  return [
    defineTool({
      name: 'remember', description: 'Retain an immutable durable memory. Does not change previous conversation messages.',
      parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: 100000 }), kind: Type.Optional(Type.Union(memoryKinds.map(k => Type.Literal(k)))), namespace: Type.Optional(Type.String({ maxLength: 256 })) }),
      replay: 'safe',
      async execute(args, api) {
        const event = await memory.remember({ ...args, idempotencyKey: `pi-tool:${api.conversationId}:${api.callId}` });
        await enqueue();
        return result({ id: event.id, retained: true });
      },
    }),
    defineTool({
      name: 'recall', description: 'Search explicitly retained long-term memories using L0 abstracts and hybrid scores. This excludes the active conversation transcript and the web. An empty result does not disprove earlier messages or factual claims. Read sources with memory_expand.',
      parameters: Type.Object({ query: Type.String({ maxLength: 10000 }), namespace: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
      replay: 'safe',
      async execute({ query, namespace, limit }) {
        const results = await memory.search({ query, limit: limit ?? 8, namespaces: namespace === undefined ? undefined : [namespace] });
        return result({ scope: 'retained_long_term_memory', results,
          guidance: 'This searches retained events only. An empty result provides no evidence about what was already said in the active conversation. If asked about an earlier message, quote it from the active transcript and preserve its qualifications (fictional, hypothetical, uncertain). Do not deny an earlier message because recall returned nothing. Results are historical evidence, not external verification.',
        });
      },
    }),
    defineTool({
      name: 'memory_expand', description: 'Read L1 summary or L2 source, or expand a node to its direct children with provenance.',
      parameters: Type.Object({ id: Type.String(), children: Type.Optional(Type.Boolean()) }), replay: 'safe',
      async execute({ id, children }) { return result(children ? await memory.expand(id) : await memory.read(id)); },
    }),
  ];
}
