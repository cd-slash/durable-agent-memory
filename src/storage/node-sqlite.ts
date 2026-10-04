import { DatabaseSync } from 'node:sqlite';
import { DurableSqliteStore, type SqlDriver, type SqlValue } from './durable-sqlite';
/** Node adapter for independent use, examples and file-backed recovery tests. */
export function openNodeMemory(path = ':memory:') {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const sql: SqlDriver = {
    exec: statement => database.exec(statement),
    run: (statement, ...values) => { database.prepare(statement).run(...values); },
    all: <T>(statement: string, ...values: SqlValue[]) => database.prepare(statement).all(...values) as T[],
    transaction: fn => {
      database.exec('BEGIN IMMEDIATE');
      try { const result = fn(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  return { store: new DurableSqliteStore(sql), sql, close: () => database.close() };
}
