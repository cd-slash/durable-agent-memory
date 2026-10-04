import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HybridMemory } from '../src/core/memory';
import { ExtractiveSummarizer } from '../src/summarization/extractive';
import { prepareTurn, SYSTEM_INSTRUCTIONS } from '../src/pi/extension';
import { sqlite, TestEmbeddings } from './helpers';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup(provider = new TestEmbeddings()) {
  const storage = sqlite(); cleanups.push(() => storage.db.close());
  const memory = new HybridMemory({ store: storage.store, embeddings: provider });
  return { ...storage, memory };
}
describe('immutable binary memory', () => {
  it('creates only completed binary ranges, incrementally; historical nodes never change', async () => {
    const { memory, store } = setup();
    for (let i = 0; i < 8; i++) await memory.remember({ content: `Decision ${i}: use SQLite`, kind: 'decision' });
    expect(store.nodes()).toHaveLength(0); // append returns before all model work
    await memory.compact();
    expect(store.nodes()).toHaveLength(15);
    const historical = store.nodes();
    const ranges = historical.filter(n => n.level > 0).map(n => [n.rangeStart, n.rangeEnd, n.level]);
    expect(ranges).toEqual([[0,1,1],[2,3,1],[4,5,1],[6,7,1],[0,3,2],[4,7,2],[0,7,3]]);
    await memory.remember({ content: 'Decision 8: new outcome' });
    expect((await memory.compact()).createdNodes).toBe(1);
    await memory.remember({ content: 'Decision 9: retry' });
    expect((await memory.compact()).createdNodes).toBe(2);
    for (const old of historical) expect(await memory.read(old.id)).toEqual(old);
    expect(memory.pending()).toBe(0);
  });
  it('enforces immutability in SQLite and idempotent replay with payload validation', async () => {
    const { memory, sql } = setup();
    const first = await memory.remember({ content: 'SQLite preference', idempotencyKey: 'tool-123', metadata: { b: 1, a: 2 } });
    expect(await memory.remember({ content: 'SQLite preference', idempotencyKey: 'tool-123', metadata: { a: 2, b: 1 } })).toEqual(first);
    await expect(memory.remember({ content: 'Other', idempotencyKey: 'tool-123' })).rejects.toThrow('Idempotency');
    expect(() => sql.run('UPDATE hm_events SET content=? WHERE id=?', 'changed', first.id)).toThrow('immutable');
    expect(() => sql.run('DELETE FROM hm_events WHERE id=?', first.id)).toThrow('immutable');
    await memory.compact();
    expect(() => sql.run('UPDATE hm_nodes SET content_hash=?', 'wrong')).toThrow('immutable');
  });
  it('keeps namespaces separate and cannot leak filtered kinds through parent summaries', async () => {
    const { memory, store } = setup();
    await memory.remember({ content: 'database public fact', kind: 'fact', namespace: 'public' });
    await memory.remember({ content: 'database hidden instruction', kind: 'instruction', namespace: 'public' });
    await memory.remember({ content: 'database private decision', kind: 'decision', namespace: 'private' });
    await memory.compact();
    expect(store.nodes().filter(n => n.level === 1)).toHaveLength(1);
    const hits = await memory.search({ query: 'database', namespaces: ['public'], kinds: ['fact'] });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('public fact');
    const context = await memory.context({ query: 'database', namespaces: ['public'], kinds: ['fact'], maxTokens: 4000 });
    expect(context.text).not.toContain('hidden'); expect(context.text).not.toContain('private');
  });
  it('adds a new summary version without mutating the old tree', async () => {
    const { memory, store } = setup();
    await memory.remember({ content: 'Prefer SQLite' }); await memory.compact();
    const old = store.nodes();
    const summarizer = { version: 'new-v2', summarizeLeaf: async () => ({ l0: 'New abstract', l1: 'New summary' }), summarizeNode: async () => ({ l0: 'New parent', l1: 'New parent summary' }) };
    const v2 = new HybridMemory({ store, summarizer }); await v2.compact();
    expect(store.nodes()).toHaveLength(2); expect(store.nodes(old[0].version)).toEqual(old);
    expect((await v2.search({ query: 'New' }))[0].text).toBe('New abstract');
  });
  it('resumes missing work after a summarizer failure and serializes concurrent drains', async () => {
    const { store, memory } = setup();
    await memory.remember({ content: 'Database preference' });
    let failed = false;
    const summarizer = new ExtractiveSummarizer();
    const original = summarizer.summarizeLeaf.bind(summarizer);
    summarizer.summarizeLeaf = async e => { if (!failed) { failed = true; throw new Error('offline'); } return original(e); };
    const engine = new HybridMemory({ store, summarizer });
    await expect(engine.compact()).rejects.toThrow('offline'); expect(engine.pending()).toBe(1);
    await Promise.all([engine.compact(), engine.compact()]); expect(engine.pending()).toBe(0); expect(store.nodes()).toHaveLength(1);
  });
  it('ignores extra summarizer fields and validates external filters', async () => {
    const { store, memory } = setup();
    await memory.remember({ content: 'Valid event' });
    const summary = { l0: 'Valid abstract', l1: 'Valid summary', id: 'overridden', type: 'event' };
    const engine = new HybridMemory({ store, summarizer: { version: 'untrusted-output-v1', summarizeLeaf: async () => summary, summarizeNode: async () => summary } });
    await engine.compact();
    const node = store.nodes('untrusted-output-v1')[0];
    expect(node.type).toBe('node'); expect(node.id).toMatch(/^n_[a-f0-9]{64}$/);
    await expect(engine.search({ query: 'test', kinds: ['bad' as never] })).rejects.toThrow('Invalid kind');
    await expect(engine.search({ query: 'test', namespaces: 'bad' as never })).rejects.toThrow('Invalid namespace');
  });
  it('an explicit compact finishes pending work when a bounded job is already running', async () => {
    const { memory, store } = setup();
    for (let i = 0; i < 8; i++) await memory.remember({ content: `Memory ${i}` });
    const bounded = memory.compact({ maxWork: 1 });
    const full = memory.compact();
    expect((await bounded).createdNodes).toBe(1);
    expect((await full).pending).toBe(0); expect(store.nodes()).toHaveLength(15);
  });
  it('reindexes a different embedding model without altering sources', async () => {
    const { memory, store } = setup();
    await memory.remember({ content: 'SQLite is my favourite' }); await memory.compact();
    const before = store.events();
    const other = new HybridMemory({ store, embeddings: new TestEmbeddings('new-model') });
    expect(other.pending()).toBe(1); await other.compact();
    expect(store.events()).toEqual(before);
    expect(store.embeddings('new-model', 'fixture-v1')).toHaveLength(1);
    expect(store.embeddings('test-semantic', 'fixture-v1')).toHaveLength(1);
  });
});
describe('progressive retrieval and budgets', () => {
  it('finds semantic-only matches, exposes scores, and expands L0 -> L1 -> L2', async () => {
    const { memory, store } = setup();
    const event = await memory.remember({ content: 'My favourite database is SQLite.', kind: 'preference', namespace: 'preferences' });
    await memory.remember({ content: 'I drink espresso.', namespace: 'preferences' }); await memory.compact();
    const hits = await memory.search({ query: 'datastore', namespaces: ['preferences'], weights: { lexical: 0, semantic: 1, recency: 0 } });
    const selected = hits.find(h => h.id === event.id)!;
    expect(selected.signals.lexical).toBe(0); expect(selected.signals.semantic).toBeGreaterThan(0.99); expect(selected.representation).toBe('L0');
    const root = store.nodes().find(n => n.level === 1)!;
    const summary = await memory.read(root.id); expect(summary.type === 'node' && summary.l1).toContain('SQLite');
    const children = await memory.expand(root.id); expect(children.every(c => c.type === 'node')).toBe(true);
    expect(await memory.expand(children[0].id)).toEqual([event]);
  });
  it('combines lexical, vector and recency signals and accepts a custom scorer', async () => {
    const { memory, store } = setup();
    await memory.remember({ content: 'SQLite database' }); await memory.compact();
    const lexical = new HybridMemory({ store, now: () => Date.now() + 90 * 86400000, score: signals => signals.lexical });
    const [hit] = await lexical.search({ query: 'SQLite OR "* ()' });
    expect(hit.signals.lexical).toBeGreaterThan(0); expect(hit.signals.recency).toBeLessThan(0.06); expect(hit.score).toBe(hit.signals.lexical);
  });
  it('enforces the rendered budget including Unicode, escaped text, wrappers and provenance; removes overlaps', async () => {
    const { memory } = setup();
    for (let i = 0; i < 16; i++) await memory.remember({ content: `SQLite decision ${i}: λ🙂 "quoted". ${'Details about the database. '.repeat(20)}` });
    await memory.compact();
    for (const maxTokens of [0, 20, 200, 700, 4000]) {
      const context = await memory.context({ query: 'SQLite database', maxTokens });
      expect(new TextEncoder().encode(context.text).length).toBe(context.tokens);
      expect(context.tokens).toBeLessThanOrEqual(maxTokens);
      const allIds = context.items.flatMap(item => item.provenance.eventIds);
      expect(new Set(allIds).size).toBe(allIds.length);
    }
    await expect(memory.context({ query: 'x', maxTokens: -1 })).rejects.toThrow('maxTokens');
  });
  it('retains a buried decision in L2 even when high-level summaries omit it', async () => {
    const { memory, store } = setup();
    const old = await memory.remember({ content: 'Decision: route vision to Z.AI, text to Cerebras', kind: 'decision' });
    for (let i = 0; i < 31; i++) await memory.remember({ content: `Episode ${i}: routine maintenance` });
    await memory.compact();
    expect(store.nodes().some(n => n.level === 5 && n.eventIds.includes(old.id))).toBe(true);
    expect((await memory.search({ query: 'Cerebras' })).some(hit => hit.provenance.eventIds.includes(old.id))).toBe(true);
    expect((await memory.read(old.id)).type).toBe('event');
  });
});
describe('persistence and append-only tail', () => {
  it('survives closing and reopening the same SQLite database, including frozen submissions', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'hm-')); cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    const path = join(folder, 'memory.sqlite');
    let db = sqlite(path); let engine = new HybridMemory({ store: db.store });
    const event = await engine.remember({ content: 'My favourite database is SQLite.' }); await engine.compact();
    const frozen = await prepareTurn(engine, db.sql, 'What database?', 'turn-1'); const historical = db.store.nodes();
    db.db.close(); db = sqlite(path); cleanups.push(() => db.db.close()); engine = new HybridMemory({ store: db.store });
    expect(await engine.read(event.id)).toEqual(event); expect(db.store.nodes()).toEqual(historical);
    await engine.remember({ content: 'New unrelated coffee preference' });
    expect(await prepareTurn(engine, db.sql, 'What database?', 'turn-1')).toEqual(frozen);
  });
  it('memory writes never change the system instructions or historical tail text', async () => {
    const { memory, sql } = setup();
    await memory.remember({ content: 'Prefer SQLite' }); await memory.compact();
    const first = await prepareTurn(memory, sql, 'Which database?', 'one');
    const prefix = JSON.stringify({ system: SYSTEM_INSTRUCTIONS, input: first.input });
    await memory.remember({ content: 'Prefer Postgres for larger projects' }); await memory.compact();
    await prepareTurn(memory, sql, 'What changed?', 'two');
    expect(JSON.stringify({ system: SYSTEM_INSTRUCTIONS, input: (await prepareTurn(memory, sql, 'Which database?', 'one')).input })).toBe(prefix);
    await expect(prepareTurn(memory, sql, 'Other prompt', 'one')).rejects.toThrow('operationId');
  });
});
