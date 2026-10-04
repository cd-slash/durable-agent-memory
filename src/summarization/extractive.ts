import type { MemorySummarizer, MemoryEvent, SummaryNode, Summaries } from '../core/types';
/** Offline fallback. Leaves remain lossless in L2; higher summaries can lose detail. */
export class ExtractiveSummarizer implements MemorySummarizer {
  readonly version = 'extractive-v1';
  async summarizeLeaf(event: MemoryEvent): Promise<Summaries> {
    return { l0: event.content.slice(0, 240), l1: event.content.slice(0, 1400) };
  }
  async summarizeNode(children: SummaryNode[]): Promise<Summaries> {
    const joined = children.map(c => c.l1).join('\n');
    return { l0: children.map(c => c.l0).join(' / ').slice(0, 240), l1: joined.slice(0, 1600) };
  }
}
