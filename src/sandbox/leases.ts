import type { SqlDriver } from '../storage/durable-sqlite';
import type { BillingLedger } from '../billing/ledger';
import { BillingBlocked } from '../billing/policy';
import { SANDBOX } from './policy';
export interface SandboxLease { token: string; agent: string; operationId: string; deadline: number; networkRequests: number; networkBytes: number }
/** One project-wide slot; an expired lease is NOT proof its container stopped. */
export class SandboxLeases {
  constructor(private sql: SqlDriver, private billing: BillingLedger, private now = () => Date.now()) {
    sql.exec('CREATE TABLE IF NOT EXISTS sbx_lease(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,agent TEXT NOT NULL,operationId TEXT NOT NULL,deadline INTEGER NOT NULL,networkRequests INTEGER NOT NULL,networkBytes INTEGER NOT NULL)');
  }
  status(): SandboxLease | undefined { return this.sql.all<SandboxLease>('SELECT token,agent,operationId,deadline,networkRequests,networkBytes FROM sbx_lease WHERE id=1')[0]; }
  acquire(agent: string, operationId: string): SandboxLease {
    // Synchronous coordinator method: no interleaving between slot check, atomic
    // ledger reservation and slot insert. A crash may overcharge, never start unpaid work.
    {
      if (this.status()) throw new BillingBlocked('Sandbox slot occupied; confirmed cleanup required');
      this.billing.reserve({ executions: 1, tools: 1, sandboxSeconds: SANDBOX.leaseMs / 1000,
        sandboxNetworkBytes: SANDBOX.networkBytes, storageBytes: SANDBOX.storageReservation });
      const lease: SandboxLease = { token: crypto.randomUUID(), agent, operationId, deadline: this.now() + SANDBOX.leaseMs, networkRequests: 0, networkBytes: 0 };
      this.sql.run('INSERT INTO sbx_lease VALUES(1,?,?,?,?,?,?)', lease.token, agent, operationId, lease.deadline, 0, 0);
      return lease;
    }
  }
  assertActive(token: string): SandboxLease {
    const lease = this.status();
    if (this.billing.status().stopped || !lease || lease.token !== token || lease.deadline <= this.now()) throw new BillingBlocked('Sandbox lease inactive');
    return lease;
  }
  network(token: string, bytes: number) {
    this.sql.transaction(() => {
      const lease = this.assertActive(token);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > SANDBOX.requestBytes || lease.networkRequests >= SANDBOX.networkRequests
        || lease.networkBytes + bytes + SANDBOX.responseBytes > SANDBOX.networkBytes) throw new BillingBlocked('Sandbox network quota reached');
      // Conservatively charge max response size, including failures; no refunds.
      this.sql.run('UPDATE sbx_lease SET networkRequests=networkRequests+1,networkBytes=networkBytes+? WHERE id=1', bytes + SANDBOX.responseBytes);
    });
  }
  release(token: string) {
    // Called only by the singleton sandbox after native destroy() resolves. No timer-based unlock.
    this.sql.run('DELETE FROM sbx_lease WHERE id=1 AND token=?', token);
  }
}
