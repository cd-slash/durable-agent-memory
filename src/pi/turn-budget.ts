import { GenerationTask, LiveDoc, hook, type Extension } from '@earendil-works/pi-durable';
import type { SqlDriver } from '../storage/durable-sqlite';
import { BillingBlocked } from '../billing/policy';
export const MAX_REQUESTS_PER_TURN = 4;
/** Stable admitted submission ID, not a generation/task ID (those change after tools). */
export function reserveTurnRequest(sql: SqlDriver, conversation: string, submission: string) {
  sql.run('CREATE TABLE IF NOT EXISTS hm_turn_budget(conversation TEXT NOT NULL,submission TEXT NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(conversation,submission))');
  sql.transaction(() => {
    const attempts = sql.all<{attempts: number}>('SELECT attempts FROM hm_turn_budget WHERE conversation=? AND submission=?', conversation, submission)[0]?.attempts ?? 0;
    if (attempts >= MAX_REQUESTS_PER_TURN) throw new BillingBlocked('Per-turn model request limit reached; inspect tool errors before a new turn');
    sql.run('INSERT INTO hm_turn_budget VALUES(?,?,1) ON CONFLICT(conversation,submission) DO UPDATE SET attempts=attempts+1', conversation, submission);
  });
}
function ensurePrepared(sql: SqlDriver) {
  sql.run('CREATE TABLE IF NOT EXISTS hm_request_turn(id INTEGER PRIMARY KEY CHECK(id=1),conversation TEXT NOT NULL,submission TEXT NOT NULL,ready INTEGER NOT NULL)');
}
/** The actual provider boundary enforces the cap: Pi hooks report exceptions but do not necessarily block requests. */
export function reservePreparedTurnRequest(sql: SqlDriver) {
  ensurePrepared(sql);
  const active = sql.all<{conversation:string;submission:string;ready:number}>('SELECT * FROM hm_request_turn WHERE id=1')[0];
  if (!active?.ready) throw new BillingBlocked('Model request has no prepared admitted turn');
  sql.run('UPDATE hm_request_turn SET ready=0 WHERE id=1');
  reserveTurnRequest(sql, active.conversation, active.submission);
}
export function turnBudgetExtension(sql: SqlDriver): Extension {
  ensurePrepared(sql);
  return { name: 'bounded-turn-v1', hooks: [hook(GenerationTask, {
    async beforeRequest(_request, api, context) {
      sql.run('UPDATE hm_request_turn SET ready=0 WHERE id=1');
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const submission = live?.run?.inputs[0];
      if (!submission) throw new BillingBlocked('Generation has no admitted input');
      sql.run('INSERT INTO hm_request_turn VALUES(1,?,?,1) ON CONFLICT(id) DO UPDATE SET conversation=excluded.conversation,submission=excluded.submission,ready=1', String(api.conversationId), String(submission));
      // No replacement messages: historical prompt prefix stays intact.
    },
  })] };
}
