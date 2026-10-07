import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import type { HybridMemory } from '../core/memory';
import type { BillingClient } from '../billing/control';
import { BillingBlocked } from '../billing/policy';
/** Missing nodes remain the ledger. No infinite retries or auto-resume after safety stop. */
export class MemoryJobs extends LifecycleCapability {
  constructor(private readonly memory: HybridMemory, private readonly billing: BillingClient) { super('hybrid-memory'); }
  // Startup must not automatically restart pending paid work after eviction/deployment.
  async enqueue(): Promise<void> {
    await this.billing.assertRunning();
    await this.lifecycle.jobs.push({ id: 'hm-drain', fn: 'compact', time: Date.now(), singleflight: true, hungTimeoutSeconds: 120, recoveryLoop: false });
  }
  async onJob(_context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    try {
      await this.billing.assertRunning();
      // One bounded batch per explicit enqueue. Pending work requires another explicit enqueue/compact.
      await this.memory.compact({ maxWork: 4 });
    } catch (error) {
      console.warn(error instanceof BillingBlocked ? 'hm_billing_stopped' : 'hm_summary_paused');
    }
    return undefined;
  }
}
