import type { CompactionResult, ContextInput, EmbeddingProvider, MemoryContext, MemoryEvent, MemoryRecord, MemoryStore, MemorySummarizer, RememberInput, SearchInput, SearchResult, SummaryNode, TokenCounter, ScoreSignals, ScoreWeights } from './types';
import { memoryKinds } from './types';
import { canonical, completedRanges, sha256 } from './hierarchy';
import { cosine, defaultWeights, validateVector, weightedScore } from './retrieval';
import { buildContext, conservativeTokens } from './context-builder';
import { ExtractiveSummarizer } from '../summarization/extractive';
export interface MemoryOptions {
  store: MemoryStore; embeddings?: EmbeddingProvider; summarizer?: MemorySummarizer;
  tokens?: TokenCounter; now?: () => number;
  score?: (signals: ScoreSignals, weights: ScoreWeights) => number;
  beforeWrite?: (input: RememberInput) => Promise<void>;
}
export class HybridMemory {
  readonly store: MemoryStore;
  readonly summarizer: MemorySummarizer;
  private readonly now: () => number;
  private compacting?: Promise<CompactionResult>;
  constructor(private readonly options: MemoryOptions) {
    this.store = options.store;
    this.summarizer = options.summarizer ?? new ExtractiveSummarizer();
    this.now = options.now ?? Date.now;
  }
  async remember(input: RememberInput): Promise<MemoryEvent> {
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 100_000) throw new Error('Memory content must contain 1–100000 characters');
    const kind = input.kind ?? 'observation', namespace = input.namespace ?? '';
    if (!memoryKinds.includes(kind) || typeof namespace !== 'string' || namespace.length > 256) throw new Error('Invalid kind or namespace');
    if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 512)) throw new Error('Invalid idempotency key');
    const metadata = input.metadata ?? {};
    const contentHash = await sha256(canonical({ content: input.content, kind, namespace, metadata }));
    const id = input.idempotencyKey ? 'e_' + await sha256(input.idempotencyKey) : 'e_' + crypto.randomUUID();
    await this.options.beforeWrite?.(input);
    return this.store.append({ type: 'event', id, createdAt: this.now(), kind, namespace, content: input.content, metadata: JSON.parse(canonical(metadata)), contentHash });
  }
  async read(id: string): Promise<MemoryRecord> {
    const record = this.store.read(id);
    if (!record) throw new Error('Memory not found');
    return record;
  }
  /** L0 hit -> read() loads L1; expand() loads direct children; depth can be chosen by callers. */
  async expand(id: string): Promise<MemoryRecord[]> {
    const record = await this.read(id);
    return record.type === 'event' ? [record] : Promise.all(record.children.map(child => this.read(child)));
  }
  compact(options: { maxWork?: number } = {}): Promise<CompactionResult> {
    const maxWork = options.maxWork ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new Error('maxWork must be a positive integer');
    if (!this.compacting) this.compacting = this.drain(maxWork).finally(() => { this.compacting = undefined; });
    return this.compacting.then(async result => {
      // An explicit unbounded compact must also finish work admitted during an existing bounded job.
      if (options.maxWork === undefined && result.pending) {
        const next = await this.compact();
        return { createdNodes: result.createdNodes + next.createdNodes, embedded: result.embedded + next.embedded, pending: next.pending };
      }
      return result;
    });
  }
  pending(): number {
    const events = this.store.events(), nodes = this.store.nodes(this.summarizer.version);
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.namespace, (counts.get(event.namespace) ?? 0) + 1);
    let pending = [...counts.values()].reduce((n, count) => n + completedRanges(count).length, 0) - nodes.length;
    const provider = this.options.embeddings;
    if (provider) {
      const indexed = new Set(this.store.embeddings(provider.model, provider.version).map(e => e.id));
      pending += nodes.filter(n => !indexed.has(n.id)).length;
    }
    return Math.max(0, pending);
  }
  private async drain(maxWork: number): Promise<CompactionResult> {
    const events = this.store.events(), groups = new Map<string, MemoryEvent[]>();
    for (const event of events) { const group = groups.get(event.namespace) ?? []; group.push(event); groups.set(event.namespace, group); }
    const key = (ns: string, start: number, end: number) => canonical([ns, start, end]);
    const existing = new Map(this.store.nodes(this.summarizer.version).map(n => [key(n.namespace, n.rangeStart, n.rangeEnd), n]));
    let createdNodes = 0, embedded = 0, work = 0;
    for (const [namespace, group] of groups) {
      for (const { start, end, level } of completedRanges(group.length)) {
        const rangeKey = key(namespace, start, end);
        if (existing.has(rangeKey)) continue;
        if (work >= maxWork) break;
        const middle = (start + end - 1) / 2;
        const children = level === 0 ? [] : [existing.get(key(namespace, start, middle))!, existing.get(key(namespace, middle + 1, end))!];
        if (children.some(c => !c)) continue;
        const summaries = level === 0 ? await this.summarizer.summarizeLeaf(group[start]) : await this.summarizer.summarizeNode(children);
        if (typeof summaries.l0 !== 'string' || typeof summaries.l1 !== 'string' || !summaries.l0.trim() || !summaries.l1.trim() || summaries.l0.length > 2000 || summaries.l1.length > 12000) throw new Error('Summarizer returned invalid representations');
        const childIds = level === 0 ? [group[start].id] : children.map(c => c.id);
        const contentHash = await sha256(canonical({ namespace, start, end, level, version: this.summarizer.version, summaries: { l0: summaries.l0, l1: summaries.l1 }, childHashes: level === 0 ? [group[start].contentHash] : children.map(c => c.contentHash) }));
        const node: SummaryNode = { type: 'node', id: 'n_' + contentHash, namespace, rangeStart: start, rangeEnd: end, level, l0: summaries.l0, l1: summaries.l1, createdAt: this.now(), contentHash, version: this.summarizer.version, children: childIds, eventIds: group.slice(start, end + 1).map(e => e.id), kinds: [...new Set(group.slice(start, end + 1).map(e => e.kind))] };
        this.store.insertNode(node);
        existing.set(rangeKey, node); createdNodes++; work++;
      }
    }
    const provider = this.options.embeddings;
    if (provider) {
      const embeddedIds = new Set(this.store.embeddings(provider.model, provider.version).map(e => e.id));
      const missing = this.store.nodes(this.summarizer.version).filter(n => !embeddedIds.has(n.id)).slice(0, Math.max(0, maxWork - work));
      for (let start = 0; start < missing.length; start += 16) {
        const batch = missing.slice(start, start + 16);
        const vectors = await provider.embed(batch.map(n => n.l0 + '\n' + n.l1));
        if (vectors.length !== batch.length) throw new Error('Embedding batch length mismatch');
        vectors.forEach(validateVector);
        vectors.forEach((vector, i) => this.store.putEmbedding({ id: batch[i].id, model: provider.model, version: provider.version, vector }));
        embedded += vectors.length;
      }
    }
    return { createdNodes, embedded, pending: this.pending() };
  }
  async search(input: SearchInput): Promise<SearchResult[]> {
    if (typeof input.query !== 'string' || input.query.length > 10000) throw new Error('Invalid query');
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new Error('limit must be an integer from 0 to 1000');
    for (const namespaces of [input.namespaces]) {
      if (namespaces !== undefined && (!Array.isArray(namespaces) || namespaces.some(n => typeof n !== 'string' || n.length > 256))) throw new Error('Invalid namespace filters');
    }
    if (input.kinds !== undefined && (!Array.isArray(input.kinds) || input.kinds.some(k => !memoryKinds.includes(k)))) throw new Error('Invalid kind filters');
    if (input.includeRecent !== undefined && typeof input.includeRecent !== 'boolean') throw new Error('Invalid includeRecent');
    const events = this.store.events(), nodes = this.store.nodes(this.summarizer.version);
    const eventMap = new Map(events.map(e => [e.id, e]));
    const leaves = new Map(nodes.filter(n => n.level === 0).map(n => [n.eventIds[0], n]));
    const lexical = this.store.lexical(input.query);
    const vectors = new Map<string, number[]>();
    let queryVector: number[] = [];
    const provider = this.options.embeddings;
    if (provider && input.query.trim()) {
      queryVector = (await provider.embed([input.query]))[0];
      validateVector(queryVector);
      for (const embedding of this.store.embeddings(provider.model, provider.version)) vectors.set(embedding.id, embedding.vector);
    }
    const weights = { ...defaultWeights, ...input.weights };
    if (Object.values(weights).some(v => !Number.isFinite(v) || v < 0)) throw new Error('Weights must be finite and nonnegative');
    const score = this.options.score ?? weightedScore;
    const results: SearchResult[] = [];
    for (const record of [...events, ...nodes.filter(n => n.level > 0)]) {
      if (input.namespaces && !input.namespaces.includes(record.namespace)) continue;
      const sources = record.type === 'event' ? [record] : record.eventIds.map(id => eventMap.get(id)!);
      // All descendants must pass: a summary cannot leak a filtered-out kind.
      if (input.kinds && sources.some(e => !input.kinds!.includes(e.kind))) continue;
      const abstract = record.type === 'event' ? leaves.get(record.id) : record;
      const id = abstract?.id ?? record.id;
      const signals = {
        semantic: queryVector.length ? cosine(queryVector, vectors.get(id) ?? []) : 0,
        lexical: Math.max(lexical.get(id) ?? 0, lexical.get(record.id) ?? 0),
        recency: Math.exp(-Math.max(0, this.now() - Math.max(...sources.map(e => e.createdAt))) / (30 * 86400000)),
      };
      if (!input.includeRecent && !signals.lexical && !signals.semantic) continue;
      results.push({ id: record.id, type: record.type, representation: 'L0', text: abstract?.l0 ?? (record as MemoryEvent).content.slice(0, 240), namespace: record.namespace, signals, score: score(signals, weights), provenance: { eventIds: sources.map(e => e.id), contentHash: record.contentHash, ...(abstract ? { summaryVersion: abstract.version } : {}) } });
    }
    return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }
  async context(input: ContextInput): Promise<MemoryContext> {
    const results = await this.search({ ...input, limit: input.limit ?? 100 });
    const leaves = new Map(this.store.nodes(this.summarizer.version).filter(n => n.level === 0).map(n => [n.eventIds[0], n]));
    const candidates = results.map(({ representation: _, text: l0, ...result }) => {
      const record = this.store.read(result.id)!;
      const summary = record.type === 'node' ? record : leaves.get(record.id);
      const choices: Array<{ representation: 'L0' | 'L1' | 'L2'; text: string }> = [];
      if (record.type === 'event' && record.content.length <= 1600) choices.push({ representation: 'L2', text: record.content });
      if (summary) choices.push({ representation: 'L1', text: summary.l1 });
      choices.push({ representation: 'L0', text: l0 });
      return { result, choices };
    });
    return buildContext(candidates, input.maxTokens, this.options.tokens ?? conservativeTokens);
  }
}
export * from './types';
