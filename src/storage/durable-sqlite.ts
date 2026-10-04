import type { EmbeddingRecord, MemoryEvent, MemoryRecord, MemoryStore, SummaryNode } from '../core/types';
import { schema } from './schema';
export type SqlValue = string | number | null;
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, ...bindings: SqlValue[]): void;
  all<T>(sql: string, ...bindings: SqlValue[]): T[];
  transaction<T>(fn: () => T): T;
}
type EventRow = { id: string; sequence: number; position: number; namespace: string; created_at: number; kind: MemoryEvent['kind']; content: string; metadata_json: string; content_hash: string };
function eventFromRow(r: EventRow): MemoryEvent {
  return { type: 'event', id: r.id, sequence: r.sequence, position: r.position, namespace: r.namespace, createdAt: r.created_at, kind: r.kind, content: r.content, metadata: JSON.parse(r.metadata_json), contentHash: r.content_hash };
}
export class DurableSqliteStore implements MemoryStore {
  constructor(readonly sql: SqlDriver) { sql.exec(schema); }
  append(event: Omit<MemoryEvent, 'sequence' | 'position'>): MemoryEvent {
    return this.sql.transaction(() => {
      const existing = this.read(event.id);
      if (existing) {
        if (existing.type !== 'event' || existing.contentHash !== event.contentHash) throw new Error('Idempotency key reused with different memory');
        return existing;
      }
      const position = this.sql.all<{ next: number }>('SELECT COALESCE(MAX(position)+1,0) AS next FROM hm_events WHERE namespace=?', event.namespace)[0].next;
      this.sql.run('INSERT INTO hm_events(id,position,namespace,created_at,kind,content,metadata_json,content_hash) VALUES(?,?,?,?,?,?,?,?)', event.id, position, event.namespace, event.createdAt, event.kind, event.content, JSON.stringify(event.metadata), event.contentHash);
      this.sql.run('INSERT INTO hm_fts(id,text) VALUES(?,?)', event.id, event.content);
      return this.read(event.id) as MemoryEvent;
    });
  }
  events(): MemoryEvent[] { return this.sql.all<EventRow>('SELECT * FROM hm_events ORDER BY sequence').map(eventFromRow); }
  nodes(version?: string): SummaryNode[] {
    return this.sql.all<{ record_json: string }>('SELECT record_json FROM hm_nodes' + (version ? ' WHERE version=?' : '') + ' ORDER BY level, range_start', ...(version ? [version] : [])).map(r => JSON.parse(r.record_json));
  }
  insertNode(node: SummaryNode): void {
    this.sql.transaction(() => {
      if (this.read(node.id)) return;
      this.sql.run('INSERT INTO hm_nodes VALUES(?,?,?,?,?,?,?,?,?)', node.id, node.namespace, node.rangeStart, node.rangeEnd, node.level, node.version, node.createdAt, node.contentHash, JSON.stringify(node));
      this.sql.run('INSERT INTO hm_fts(id,text) VALUES(?,?)', node.id, node.l0 + '\n' + node.l1);
    });
  }
  read(id: string): MemoryRecord | undefined {
    const e = this.sql.all<EventRow>('SELECT * FROM hm_events WHERE id=?', id)[0];
    if (e) return eventFromRow(e);
    const n = this.sql.all<{ record_json: string }>('SELECT record_json FROM hm_nodes WHERE id=?', id)[0];
    return n && JSON.parse(n.record_json);
  }
  lexical(query: string): Map<string, number> {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 64);
    if (!terms.length) return new Map();
    const expression = terms.map(t => '"' + t + '"').join(' OR ');
    const hits = this.sql.all<{ id: string; rank: number }>('SELECT id, bm25(hm_fts) AS rank FROM hm_fts WHERE hm_fts MATCH ?', expression);
    const max = Math.max(0, ...hits.map(h => -h.rank));
    return new Map(hits.map(h => [h.id, max ? -h.rank / max : 0]));
  }
  embeddings(model: string, version: string): EmbeddingRecord[] {
    return this.sql.all<{ id: string; vector_json: string }>('SELECT id,vector_json FROM hm_embeddings WHERE model=? AND version=?', model, version).map(r => ({ id: r.id, model, version, vector: JSON.parse(r.vector_json) }));
  }
  putEmbedding(record: EmbeddingRecord): void {
    this.sql.run('INSERT OR IGNORE INTO hm_embeddings VALUES(?,?,?,?)', record.id, record.model, record.version, JSON.stringify(record.vector));
  }
}
export function durableObjectDriver(storage: DurableObjectStorage): SqlDriver {
  return {
    exec: sql => { storage.sql.exec(sql); },
    run: (sql, ...bindings) => { storage.sql.exec(sql, ...bindings); },
    all: <T>(sql: string, ...bindings: SqlValue[]) => [...storage.sql.exec(sql, ...bindings)] as T[],
    transaction: fn => storage.transactionSync(fn),
  };
}
