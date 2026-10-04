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
      name: 'recall', description: 'Search L0 memory abstracts with semantic, lexical and recency scores. Read selected sources with memory_expand.',
      parameters: Type.Object({ query: Type.String({ maxLength: 10000 }), namespace: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
      replay: 'safe',
      async execute({ query, namespace, limit }) { return result(await memory.search({ query, limit: limit ?? 8, namespaces: namespace === undefined ? undefined : [namespace] })); },
    }),
    defineTool({
      name: 'memory_expand', description: 'Read L1 summary or L2 source, or expand a node to its direct children with provenance.',
      parameters: Type.Object({ id: Type.String(), children: Type.Optional(Type.Boolean()) }), replay: 'safe',
      async execute({ id, children }) { return result(children ? await memory.expand(id) : await memory.read(id)); },
    }),
  ];
}
