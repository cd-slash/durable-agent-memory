import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { EntryRecord, SnapshotEvent } from '@earendil-works/pi-durable';
import { RpcProjector, type RpcRecord } from '../src/bridge/projector';
import { DurableRpcBridge } from '../src/bridge/bridge';
const entry = (id: number, text: string) => ({ id, conversationId: 1, kind: 'pi.assistant', model: [fauxAssistantMessage(text)] }) as unknown as EntryRecord;
const snapshot = (entries: EntryRecord[], partial?: string) => ({ type: 'snapshot', entries, tools: [], compactions: [], inbox: [], agent: {}, usage: {}, ...(partial ? { generation: { attempt: 1, message: fauxAssistantMessage(partial) } } : {}) }) as unknown as SnapshotEvent;
it('translates Pi Durable streaming and reconnect snapshots without duplicating text or historical messages', () => {
  const out: RpcRecord[] = [], projector = new RpcProjector(e => out.push(e), ['1:0']);
  projector.snapshot(snapshot([entry(1, 'old history')], 'Hel'));
  projector.snapshot(snapshot([entry(1, 'old history')], 'Hello'));
  projector.events([{ type: 'message_update', usage: fauxAssistantMessage('').usage, changes: [{ type: 'text_delta', contentIndex: 0, delta: ' world' }] }]);
  projector.events([{ type: 'message_end', entry: entry(2, 'Hello world') }]);
  projector.finish([entry(1, 'old history'), entry(2, 'Hello world')]);
  expect(out.filter(e => e.type === 'message_update').map(e => (e.assistantMessageEvent as { delta: string }).delta).join('')).toBe('Hello world');
  expect(out.filter(e => e.type === 'message_start')).toHaveLength(1);
  expect(out.filter(e => e.type === 'message_end')).toHaveLength(1);
});
it('repairs a missed final event from authoritative transcript and detects prefix divergence', () => {
  const out: RpcRecord[] = [], projector = new RpcProjector(e => out.push(e));
  projector.snapshot(snapshot([], 'Hello'));
  expect(() => projector.snapshot(snapshot([], 'Goodbye'))).toThrow('prefix');
  projector.finish([entry(2, 'Hello world')]);
  expect(out.filter(e => e.type === 'message_update').map(e => (e.assistantMessageEvent as { delta: string }).delta).join('')).toBe('Hello world');
});
it('persists isolated remote session identities; refuses endpoint changes, foreign files and unsupported commands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-')), out: RpcRecord[] = [];
  const options = { url: 'https://example.com', token: 'test-only', sessionsDir: dir, emit: (e: RpcRecord) => out.push(e), fetch: (async () => Response.json({ isStreaming: false })) as typeof fetch };
  try {
    const first = new DurableRpcBridge(options), file = first.sessionFile;
    const second = new DurableRpcBridge(options);
    expect(second.sessionFile).not.toBe(file);
    const resumed = new DurableRpcBridge(options, file);
    expect(resumed.sessionFile).toBe(file);
    expect(() => new DurableRpcBridge({ ...options, url: 'https://other.example' }, file)).toThrow('endpoint');
    expect(() => new DurableRpcBridge({ ...options, url: 'http://example.com' })).toThrow('HTTPS');
    await first.handle({ type: 'fork', id: 'fork' });
    expect(out.at(-1)).toMatchObject({ command: 'fork', id: 'fork', success: false });
    await first.handle({ type: 'prompt', message: 'hello', images: [{ type: 'image' }], id: 'image' });
    expect(out.at(-1)).toMatchObject({ success: false, error: 'Images are not supported' });
    await first.handle({ type: 'switch_session', sessionPath: '/etc/passwd' });
    expect(out.at(-1)).toMatchObject({ success: false });
    await new DurableRpcBridge({ ...options, toolsDisabled: true }).handle({ type: 'prompt', message: 'hello' });
    expect(out.at(-1)).toMatchObject({ success: false, error: expect.stringContaining('Tool-free') });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('preserves initial nonempty message/start blocks from Workers AI before applying deltas', () => {
  const out: RpcRecord[] = [], projector = new RpcProjector(e => out.push(e));
  projector.events([{ type: 'message_start', message: fauxAssistantMessage('First') }]);
  projector.events([{ type: 'message_update', usage: fauxAssistantMessage('').usage, changes: [
    { type: 'text_delta', contentIndex: 0, delta: ' block' },
    { type: 'text_start', contentIndex: 1, block: { type: 'text', text: 'Second' } },
    { type: 'text_delta', contentIndex: 1, delta: ' block' },
  ] }]);
  const final = fauxAssistantMessage([{ type: 'text', text: 'First block' }, { type: 'text', text: 'Second block' }]);
  projector.finish([{ ...entry(3, ''), model: [final] }]);
  const updates = out.filter(e => e.type === 'message_update').map(e => e.assistantMessageEvent as { contentIndex: number; delta: string });
  expect(updates.filter(e => e.contentIndex === 0).map(e => e.delta).join('')).toBe('First block');
  expect(updates.filter(e => e.contentIndex === 1).map(e => e.delta).join('')).toBe('Second block');
});
it('normalizes Workers AI raw JSON/stream responses and preserves the native Response', async () => {
  const { normalizeRawAIResponse, piAIBinding } = await import('../src/pi/workers-ai-binding');
  const response = Response.json({ choices: [] });
  expect(normalizeRawAIResponse(response)).toBe(response);
  expect(await normalizeRawAIResponse({ choices: [] }).json()).toEqual({ choices: [] });
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } });
  const normalized = normalizeRawAIResponse(stream);
  expect(normalized.headers.get('content-type')).toBe('text/event-stream');
  expect(await normalized.text()).toContain('[DONE]');
  expect(() => normalizeRawAIResponse(undefined)).toThrow('invalid');
  const binding = { run: async () => ({ choices: [] }) } as unknown as Ai;
  expect(await (await Reflect.apply(piAIBinding(binding).run, binding, ['@cf/zai-org/glm-4.7-flash', {}, { returnRawResponse: true }]) as unknown as Response).json()).toEqual({ choices: [] });
});
it('official Agents Pi provider accepts a normalized JSON binding response after a tool result', async () => {
  const { createAI } = await import('agents/models/pi-ai');
  const { piAIBinding } = await import('../src/pi/workers-ai-binding');
  const { fauxToolCall } = await import('@earendil-works/pi-ai');
  const binding = { run: async () => ({ choices: [{ message: { content: 'Preference recorded.' }, finish_reason: 'stop' }] }) } as unknown as Ai;
  const ai = createAI({ binding: piAIBinding(binding) }), model = ai('@cf/zai-org/glm-4.7-flash');
  const result = await ai.complete(model, { messages: [
    { role: 'user', content: 'Remember SQLite', timestamp: 1 },
    fauxAssistantMessage(fauxToolCall('remember', { content: 'SQLite' }, { id: 'remember-1' }), { stopReason: 'toolUse' }),
    { role: 'toolResult', toolCallId: 'remember-1', toolName: 'remember', content: [{ type: 'text', text: 'Stored' }], isError: false, timestamp: 2 },
  ] });
  expect(result.stopReason).toBe('stop');
  expect(result.content).toEqual([{ type: 'text', text: 'Preference recorded.' }]);
});
