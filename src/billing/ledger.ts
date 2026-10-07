import type { SqlDriver } from '../storage/durable-sqlite';
import { BILLING_LIMITS, MAX_STORAGE_RESERVATION, BillingBlocked, type BudgetKind, type Reservation } from './policy';
/** Synchronous SQLite transaction serializes reservations across ALL agent objects. No refunds/replay exemptions. */
export class BillingLedger {
  constructor(private readonly sql: SqlDriver, private readonly now = () => Date.now()) {
    sql.run('CREATE TABLE IF NOT EXISTS billing_state(id INTEGER PRIMARY KEY CHECK(id=1),stopped INTEGER NOT NULL,reason TEXT NOT NULL,changed_at INTEGER NOT NULL)');
    sql.run("INSERT OR IGNORE INTO billing_state VALUES(1,0,'',0)");
    sql.run('CREATE TABLE IF NOT EXISTS billing_usage(period TEXT NOT NULL,kind TEXT NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(period,kind))');
  }
  periods() { const iso = new Date(this.now()).toISOString(); return [iso.slice(0, 10), iso.slice(0, 7)] as const; }
  status() {
    const state = this.sql.all<{ stopped: number; reason: string; changed_at: number }>('SELECT * FROM billing_state WHERE id=1')[0];
    const [day, month] = this.periods();
    return { stopped: !!state.stopped, reason: state.reason, changedAt: state.changed_at, day, month, limits: BILLING_LIMITS, reservations: this.sql.all("SELECT * FROM billing_usage WHERE period IN (?,?,'lifetime')", day, month), caveat: 'Project quotas and conservative neuron estimates, not an account-wide billing cap. In-flight operations and incoming HTTP traffic can still incur charges.' };
  }
  stop(reason: string) { this.sql.run('UPDATE billing_state SET stopped=1,reason=?,changed_at=? WHERE id=1', reason.slice(0, 200), this.now()); }
  resume() { this.sql.run("UPDATE billing_state SET stopped=0,reason='',changed_at=? WHERE id=1", this.now()); }
  reserve(reservation: Reservation) {
    // Validate before touching any usage. Internal API still rejects malformed requests.
    const entries = Object.entries(reservation) as Array<[BudgetKind, number]>;
    if (!entries.length || entries.some(([kind, amount]) => !Object.hasOwn(BILLING_LIMITS, kind) || !Number.isSafeInteger(amount) || amount < 1)) throw new BillingBlocked('Invalid budget reservation');
    const failure = this.sql.transaction(() => {
      if (this.status().stopped) return 'Emergency stop is active';
      const periods = this.periods();
      for (const [kind, amount] of entries) {
        const keyPeriods = kind === 'storageBytes' ? [...periods, 'lifetime'] : periods;
        for (let i = 0; i < keyPeriods.length; i++) {
          const used = this.sql.all<{ used: number }>('SELECT used FROM billing_usage WHERE period=? AND kind=?', keyPeriods[i], kind)[0]?.used ?? 0;
          if (used + amount > (i === 2 ? MAX_STORAGE_RESERVATION : BILLING_LIMITS[kind][i === 0 ? 'day' : 'month'])) {
            const reason = `${kind} ${i === 0 ? 'daily' : i === 1 ? 'monthly' : 'lifetime'} quota reached; explicit resume required`;
            this.stop(reason); return reason;
          }
        }
      }
      for (const [kind, amount] of entries) for (const period of (kind === 'storageBytes' ? [...periods, 'lifetime'] : periods)) this.sql.run('INSERT INTO billing_usage VALUES(?,?,?) ON CONFLICT(period,kind) DO UPDATE SET used=used+excluded.used', period, kind, amount);
      // Retain two months of ledger rows; stopped state never expires on rollover.
      this.sql.run('DELETE FROM billing_usage WHERE period < ?', new Date(this.now() - 62 * 86400000).toISOString().slice(0, 7));
      return undefined;
    });
    if (failure) throw new BillingBlocked(failure);
  }
}
