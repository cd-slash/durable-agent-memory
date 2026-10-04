import { it, expect } from 'vitest';
import { WorkersAISummarizer } from '../src/summarization/workers-ai';
import { WorkersAIEmbeddings } from '../src/embeddings/workers-ai';
import type { MemoryEvent } from '../src/core/types';
const event: MemoryEvent = { type: 'event', id: 'e_test', sequence: 1, position: 0, createdAt: 0, kind: 'preference', namespace: '', content: 'Prefer SQLite', metadata: {}, contentHash: 'test' };
it.each([
  { response: '{"l0":"Database preference","l1":"The user prefers SQLite."}' },
  { choices: [{ message: { content: '```json\n{"l0":"Database preference","l1":"The user prefers SQLite."}\n```', reasoning_content: 'Not summary content' } }] },
])('reads Workers AI native and OpenAI-compatible summary responses', async response => {
  const summarizer = new WorkersAISummarizer({ run: async () => response });
  expect(await summarizer.summarizeLeaf(event)).toEqual({ l0: 'Database preference', l1: 'The user prefers SQLite.' });
});
it('rejects truncated or malformed summary responses, leaving source retryable', async () => {
  const summarizer = new WorkersAISummarizer({ run: async () => ({ choices: [{ message: { content: '{"l0":' } }] }) });
  await expect(summarizer.summarizeLeaf(event)).rejects.toThrow();
});
it('validates Workers AI embedding batches before persisting indexes', async () => {
  const valid = new WorkersAIEmbeddings({ run: async () => ({ data: [[0.5, 0.5]] }) });
  expect(await valid.embed(['source'])).toEqual([[0.5, 0.5]]);
  const bad = new WorkersAIEmbeddings({ run: async () => ({ data: [] }) });
  await expect(bad.embed(['source'])).rejects.toThrow('length mismatch');
});
