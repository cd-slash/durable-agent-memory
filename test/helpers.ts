import { openNodeMemory } from '../src/storage/node-sqlite';
import type { EmbeddingProvider } from '../src/core/types';
export function sqlite(path = ':memory:') {
  const opened = openNodeMemory(path);
  return { sql: opened.sql, store: opened.store, db: { close: opened.close } };
}
/** Test fixture only: synonym dimensions let retrieval assertions exercise genuine vector scoring without network. */
export class TestEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly version = 'fixture-v1';
  constructor(model = 'test-semantic') { this.model = model; }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => {
      const s = t.toLowerCase();
      return [Number(/sqlite|database|datastore|storage engine/.test(s)), Number(/vision|image|routing|cerebras/.test(s)), Number(/coffee|espresso|drink/.test(s)), 0];
    });
  }
}
