export const memoryKinds = ['observation', 'preference', 'decision', 'fact', 'episode', 'outcome', 'error', 'instruction'] as const;
export type MemoryKind = typeof memoryKinds[number];
export interface RememberInput {
  content: string;
  kind?: MemoryKind;
  namespace?: string;
  metadata?: Record<string, unknown>;
  /** Stable caller key makes replayed writes exactly-once. Reusing it with different input fails. */
  idempotencyKey?: string;
}
export interface MemoryEvent {
  type: 'event'; id: string; sequence: number; position: number; createdAt: number;
  kind: MemoryKind; namespace: string; content: string; metadata: Record<string, unknown>;
  contentHash: string;
}
export interface SummaryNode {
  type: 'node'; id: string; namespace: string; rangeStart: number; rangeEnd: number;
  level: number; l0: string; l1: string; createdAt: number; contentHash: string;
  version: string; children: string[]; eventIds: string[]; kinds: MemoryKind[];
}
export type MemoryRecord = MemoryEvent | SummaryNode;
export interface EmbeddingProvider {
  readonly model: string;
  readonly version: string;
  embed(texts: string[]): Promise<number[][]>;
}
export interface Summaries { l0: string; l1: string }
export interface MemorySummarizer {
  readonly version: string;
  summarizeLeaf(event: MemoryEvent): Promise<Summaries>;
  summarizeNode(children: SummaryNode[]): Promise<Summaries>;
}
export interface Filters { namespaces?: string[]; kinds?: MemoryKind[] }
export interface SearchInput extends Filters {
  query: string; limit?: number; includeRecent?: boolean;
  weights?: Partial<ScoreWeights>;
}
export interface ScoreWeights { semantic: number; lexical: number; recency: number }
export interface ScoreSignals { semantic: number; lexical: number; recency: number }
export interface SearchResult {
  id: string; type: MemoryRecord['type']; representation: 'L0'; text: string;
  namespace: string; score: number; signals: ScoreSignals;
  provenance: { eventIds: string[]; contentHash: string; summaryVersion?: string };
}
export interface ContextInput extends SearchInput { maxTokens: number }
export interface ContextItem extends Omit<SearchResult, 'representation'> {
  representation: 'L0' | 'L1' | 'L2'; tokens: number;
}
export interface MemoryContext {
  items: ContextItem[]; text: string; tokens: number; maxTokens: number;
  tokenizer: string;
}
export interface CompactionResult { createdNodes: number; embedded: number; pending: number }
export interface TokenCounter { readonly name: string; count(text: string): number }
export interface EmbeddingRecord { id: string; model: string; version: string; vector: number[] }
export interface MemoryStore {
  append(event: Omit<MemoryEvent, 'sequence' | 'position'>): MemoryEvent;
  events(): MemoryEvent[];
  nodes(version?: string): SummaryNode[];
  insertNode(node: SummaryNode): void;
  read(id: string): MemoryRecord | undefined;
  lexical(query: string): Map<string, number>;
  embeddings(model: string, version: string): EmbeddingRecord[];
  putEmbedding(record: EmbeddingRecord): void;
}
