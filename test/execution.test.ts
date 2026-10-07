import { expect, it } from 'vitest';
import { executionResult } from '../src/execution/results';
import { reserveTurnRequest, reservePreparedTurnRequest } from '../src/pi/turn-budget';
import { sqlite } from './helpers';
it('marks nonzero program exits as errors while retaining original execution evidence and recovery guidance', () => {
  const raw = { content: [{ type: 'text' as const, text: JSON.stringify({ exitCode: 1, stderr: 'default object is not callable', stdout: '' }) }], isError: false };
  const result = executionResult(raw);
  expect(result.isError).toBe(true); expect(result.content?.[0]).toEqual(raw.content[0]);
  expect(JSON.stringify(result.content)).toContain('default-exported FUNCTION');
  expect(JSON.stringify(result.content)).toContain('no successful file write');
  expect(raw.isError).toBe(false);
});
it('preserves successful results and marks syntax failures without inventing output', () => {
  const success = { content: [{ type: 'text' as const, text: JSON.stringify({ exitCode: 0, result: 42 }) }] };
  expect(executionResult(success)).toBe(success);
  const failed = executionResult({ isError: true, content: [{ type: 'text', text: "'return' outside of function" }] });
  expect(failed.isError).toBe(true); expect(failed.content?.[0]).toEqual({ type: 'text', text: "'return' outside of function" });
});
it('bounds all model requests in a turn across generation changes and ledger reconstruction', () => {
  const { sql, db } = sqlite();
  for (let i = 0; i < 4; i++) reserveTurnRequest(sql, 'conversation', 'admitted-input');
  expect(() => reserveTurnRequest(sql, 'conversation', 'admitted-input')).toThrow('Per-turn model request limit');
  expect(sql.all('SELECT attempts FROM hm_turn_budget')[0]).toEqual({ attempts: 4 });
  expect(() => reserveTurnRequest(sql, 'conversation', 'next-input')).not.toThrow();
  db.close();
});

it('official Pi hook bounds a looping model across tool rounds and keeps its ledger after reopen', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai');
  const { createModels } = await import('@earendil-works/pi-ai/models');
  const { createRegistry, Harness } = await import('@earendil-works/pi-durable');
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
  const { turnBudgetExtension } = await import('../src/pi/turn-budget');
  const folder = mkdtempSync(join(tmpdir(), 'pi-turn-budget-')); const file = join(folder, 'agent.sqlite');
  const faux = fauxProvider(); const models = createModels();
  models.setProvider(new Proxy(faux.provider, {get(target,key) {
    if (key === 'streamSimple') return (...args: unknown[]) => { reservePreparedTurnRequest(db.sql); return Reflect.apply(target.streamSimple,target,args); };
    return Reflect.get(target,key);
  }}));
  faux.setResponses(Array.from({length: 8}, () => fauxAssistantMessage(fauxToolCall('noop', {}), { stopReason: 'toolUse' })));
  let db = sqlite(file); let harness: import('@earendil-works/pi-durable').Harness | undefined;
  const open = async () => {
    const registry = createRegistry(); registry.install(turnBudgetExtension(db.sql));
    registry.install({ name: 'fixture-tool', tools: [{ name: 'noop', description: 'Fixture', parameters: {type:'object',properties:{}}, replay: 'safe', async execute() {return {content:[{type:'text',text:'done'}]};} }] });
    return Harness.open(await openNodeSqliteStorage(file), { models, registry, settings: { retry: {enabled:false} }, onReport: () => {} }, BACKGROUND_CONTEXT);
  };
  try {
    harness = await open(); const model = faux.getModel();
    let root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: {provider:model.provider,modelId:model.id} } });
    await (await root.submit({type:'input',content:'Loop fixture',requestId:'loop'},BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    expect(faux.state.callCount).toBe(4); expect(db.sql.all('SELECT attempts FROM hm_turn_budget')[0]).toEqual({attempts:4});
    await harness.close(BACKGROUND_CONTEXT); harness = undefined; db.db.close();
    db = sqlite(file); harness = await open(); root = await harness.root(BACKGROUND_CONTEXT);
    expect(db.sql.all('SELECT attempts FROM hm_turn_budget')[0]).toEqual({attempts:4});
    faux.setResponses([fauxAssistantMessage('Next turn works')]);
    const next = await (await root.submit({type:'input',content:'Next turn',requestId:'next'},BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    expect(next.status).toBe('done'); expect(faux.state.callCount).toBe(5);
    expect(db.sql.all<{attempts:number}>('SELECT attempts FROM hm_turn_budget').map(row=>row.attempts).sort()).toEqual([1,4]);
  } finally { await harness?.close(BACKGROUND_CONTEXT); db.db.close(); rmSync(folder,{recursive:true,force:true}); }
}, 30000);
