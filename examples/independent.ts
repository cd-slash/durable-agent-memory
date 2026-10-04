import { HybridMemory } from '../src/core/memory';
import { openNodeMemory } from '../src/storage/node-sqlite';
// No Cloudflare runtime or HTTP handlers. Add any EmbeddingProvider for semantic retrieval.
const database = openNodeMemory(process.env.MEMORY_DB ?? ':memory:');
try {
  const memory = new HybridMemory({ store: database.store });
  await memory.remember({ content: 'My favourite database for small projects is SQLite.', kind: 'preference', namespace: 'preferences', idempotencyKey: 'example-preference' });
  await memory.compact();
  console.log(await memory.context({ query: 'Which database would I prefer?', maxTokens: 4000, namespaces: ['preferences'] }));
} finally { database.close(); }
