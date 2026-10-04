import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import type { HybridMemory } from '../core/memory';
/** Missing immutable nodes/vectors ARE the durable work ledger; the lifecycle job is only the wake. */
export class MemoryJobs extends LifecycleCapability {
  constructor(private readonly memory: HybridMemory) { super('hybrid-memory'); }
  onStart(): Promise<void> | void { if (this.memory.pending()) return this.enqueue(); }
  async enqueue(): Promise<void> {
    await this.lifecycle.jobs.push({ id: 'hm-drain', fn: 'compact', time: Date.now(), singleflight: true, hungTimeoutSeconds: 120, recoveryLoop: true });
  }
  async onJob(_context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    try {
      const result = await this.memory.compact({ maxWork: 8 });
      return result.pending ? { rescheduleAt: Date.now() + 1000 } : undefined;
    } catch {
      // Never log raw memory, provider output, or credentials.
      console.warn('hm_summary_retry');
      return { rescheduleAt: Date.now() + 60000 };
    }
  }
}
