import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sqlite } from './helpers';
import { BillingLedger } from '../src/billing/ledger';
import { BILLING_LIMITS, BillingBlocked, aiReservation } from '../src/billing/policy';
import { guardedAI } from '../src/billing/ai-binding';
it('aggregate reservations stop at the limit across reconstructed clients; rejected multi-resource reservations are atomic', async () => {
  const { sql, db } = sqlite();
  const ledger = new BillingLedger(sql);
  for (let i = 0; i < BILLING_LIMITS.turns.day; i++) new BillingLedger(sql).reserve({ turns: 1 });
  expect(() => ledger.reserve({ turns: 1, neurons: 1 })).toThrow(BillingBlocked);
  expect(ledger.status().stopped).toBe(true);
  expect(ledger.status().reservations.some((r: any) => r.kind === 'neurons')).toBe(false);
  expect(() => ledger.reserve({ requests: 1 })).toThrow();
  db.close();
});
it('stop survives actual SQLite close/reopen and UTC rollover, and resume never resets usage', () => {
  const folder = mkdtempSync(join(tmpdir(), 'hm-budget-'));
  const file = join(folder, 'budget.sqlite'); let now = Date.UTC(2026, 9, 7);
  try {
    let opened = sqlite(file); let ledger = new BillingLedger(opened.sql, () => now);
    ledger.reserve({ executions: 1 }); ledger.stop('Owner stop'); opened.db.close();
    opened = sqlite(file); ledger = new BillingLedger(opened.sql, () => now);
    expect(ledger.status().stopped).toBe(true);
    now += 86400000; expect(() => ledger.reserve({ aiCalls: 1 })).toThrow();
    ledger.resume(); ledger.reserve({ executions: 1 });
    expect(ledger.status().reservations.find((r: any) => r.period === '2026-10' && r.kind === 'executions')).toMatchObject({ used: 2 });
    opened.db.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
it('rejects unknown resources and malformed/unreviewed or oversized provider inputs without spending', () => {
  const { sql, db } = sqlite(); const ledger = new BillingLedger(sql);
  for (const reservation of [{}, { requests: -1 }, { requests: 1.1 }, { unknown: 1 }, { toString: 1 }]) expect(() => ledger.reserve(reservation as any)).toThrow();
  expect(ledger.status().reservations).toEqual([]);
  expect(() => aiReservation('unpriced-model', {})).toThrow();
  expect(() => aiReservation('@cf/zai-org/glm-4.7-flash', { messages: ['x'.repeat(40000)] })).toThrow();
  const checked = aiReservation('@cf/zai-org/glm-4.7-flash', { messages: [], max_tokens: 100000 });
  expect(checked.input.max_tokens).toBe(1024); expect(checked.input.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(checked.reservation.neurons).toBeGreaterThan(40); db.close();
});
it('reserves before inference, bounds output, counts failed attempts and never calls provider after denial', async () => {
  const { sql, db } = sqlite(); const ledger = new BillingLedger(sql); let calls = 0;
  const binding = { run: async (_model: string, input: any) => { calls++; expect(input.max_tokens).toBe(1024); throw new Error('provider failure'); } } as unknown as Ai;
  const ai = guardedAI(binding, { reserve: async r => ledger.reserve(r) });
  await expect((ai.run as any)('@cf/zai-org/glm-4.7-flash', {})).rejects.toThrow('provider failure');
  expect(ledger.status().reservations.find((r: any) => r.kind === 'aiCalls')).toMatchObject({ used: 1 });
  ledger.stop('Emergency'); await expect((ai.run as any)('@cf/zai-org/glm-4.7-flash', {})).rejects.toThrow();
  expect(calls).toBe(1); db.close();
});
it('monthly quota applies after daily rollover and a quota trip remains latched', () => {
  const { sql, db } = sqlite(); let now = Date.UTC(2026, 9, 1); const ledger = new BillingLedger(sql, () => now);
  for (let day = 0; day < 5; day++) { ledger.reserve({ executions: 10 }); now += 86400000; }
  expect(() => ledger.reserve({ executions: 1 })).toThrow('monthly');
  now = Date.UTC(2026, 10, 1); expect(() => ledger.reserve({ executions: 1 })).toThrow();
  ledger.resume(); ledger.reserve({ executions: 1 }); db.close();
});

it('lifetime storage reservations never replenish at month rollover', () => {
  const { sql, db } = sqlite(); let now = Date.UTC(2026, 9, 1); const ledger = new BillingLedger(sql, () => now);
  for (let day = 0; day < 8; day++) { ledger.reserve({ storageBytes: 16 * 1048576 }); now += 86400000; }
  now = Date.UTC(2026, 10, 1);
  expect(() => ledger.reserve({ storageBytes: 1 })).toThrow('lifetime');
  ledger.resume(); expect(() => ledger.reserve({ storageBytes: 1 })).toThrow('lifetime');
  expect(ledger.status().reservations.find((r: any) => r.period === 'lifetime')).toMatchObject({ used: 128 * 1048576 }); db.close();
});
