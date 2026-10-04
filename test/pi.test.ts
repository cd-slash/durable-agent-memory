import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type Message } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { HybridMemory } from '../src/core/memory';
import { memoryExtension, prepareTurn } from '../src/pi/extension';
import { sqlite } from './helpers';
it('official Pi runtime preserves transcript and model prompt prefixes across memory writes and SQLite reopen', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pi-hm-')), file = join(folder, 'agent.sqlite');
  const snapshots: Message[][] = [];
  const faux = fauxProvider();
  faux.setResponses([1, 2, 3].map(n => async transcript => {
    snapshots.push(structuredClone(transcript.messages));
    return fauxAssistantMessage(`Answer ${n}`);
  }));
  const context = BACKGROUND_CONTEXT, models = createModels(); models.setProvider(faux.provider);
  let db = sqlite(file), memory = new HybridMemory({ store: db.store });
  let harness: Harness | undefined;
  const open = async () => {
    const registry = createRegistry(); registry.install(memoryExtension(memory));
    return Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
  };
  try {
    await memory.remember({ content: 'My favourite database for small projects is SQLite.' }); await memory.compact();
    harness = await open();
    let root = await harness.root(context, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
    const turn = await prepareTurn(memory, db.sql, 'What database do I prefer?', 'one');
    expect((await (await root.submit({ type: 'input', content: turn.input, requestId: turn.operationId }, context)).wait(context)).status).toBe('done');
    const before = await root.context(context);
    await memory.remember({ content: 'An unrelated new preference for espresso' }); await memory.compact();
    expect((await root.context(context)).messages).toEqual(before.messages);
    const next = await prepareTurn(memory, db.sql, 'What datastore would I choose?', 'two');
    await (await root.submit({ type: 'input', content: next.input, requestId: next.operationId }, context)).wait(context);
    expect(snapshots[1].slice(0, snapshots[0].length)).toEqual(snapshots[0]);
    const transcript = (await root.context(context)).entries;
    await harness.close(context); harness = undefined; db.db.close();
    db = sqlite(file); memory = new HybridMemory({ store: db.store }); harness = await open(); root = await harness.root(context);
    expect((await root.context(context)).entries).toEqual(transcript);
    const third = await prepareTurn(memory, db.sql, 'After restart, what database?', 'three');
    await (await root.submit({ type: 'input', content: third.input, requestId: third.operationId }, context)).wait(context);
    expect(snapshots[2].slice(0, snapshots[1].length)).toEqual(snapshots[1]);
    expect(db.store.events()).toHaveLength(2);
    expect(JSON.stringify(snapshots[2])).toContain('SQLite');
  } finally { await harness?.close(context); db.db.close(); rmSync(folder, { recursive: true, force: true }); }
}, 30000);
it('Pi remember tool appends durable memory during the model loop without changing its preceding messages', async () => {
  const db = sqlite(), memory = new HybridMemory({ store: db.store }), models = createModels();
  const faux = fauxProvider(), snapshots: Message[][] = [];
  models.setProvider(faux.provider);
  faux.setResponses([
    async t => { snapshots.push(structuredClone(t.messages)); return fauxAssistantMessage(fauxToolCall('remember', { content: 'Use SQLite', kind: 'decision' }, { id: 'write-1' }), { stopReason: 'toolUse' }); },
    async t => { snapshots.push(structuredClone(t.messages)); return fauxAssistantMessage('Recorded.'); },
  ]);
  const registry = createRegistry(); registry.install(memoryExtension(memory));
  const { MemoryStorage } = await import('@earendil-works/pi-durable');
  const context = BACKGROUND_CONTEXT, harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const root = await harness.root(context, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
    const settled = await (await root.submit({ type: 'input', content: 'Remember the database decision' }, context)).wait(context);
    expect(settled.status).toBe('done'); expect(db.store.events()).toHaveLength(1);
    expect(snapshots[1].slice(0, snapshots[0].length)).toEqual(snapshots[0]);
  } finally { await harness.close(context); db.db.close(); }
}, 30000);
