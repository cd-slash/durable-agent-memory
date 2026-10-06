import type { AgentEvent, EntryRecord, SnapshotEvent } from '@earendil-works/pi-durable';
import type { AssistantMessage } from '@earendil-works/pi-ai';
export type RpcRecord = Record<string, unknown>;
/** Stateful projection; reconnect snapshots fill missing suffixes rather than replaying deltas. */
export class RpcProjector {
  private seen = new Set<string>();
  private active = false;
  private blocks = new Map<number, { type: string; text: string }>();
  private tools = new Set<string>();
  constructor(private emit: (event: RpcRecord) => void, baseline: string[] = []) {
    baseline.forEach(id => this.seen.add(id.replace(/:\d+$/, '')));
  }
  private begin(message: unknown) {
    if (this.active) return;
    this.active = true; this.blocks.clear(); this.emit({ type: 'message_start', message });
  }
  private delta(index: number, type: string, delta: string, usage?: unknown) {
    const block = this.blocks.get(index) ?? { type, text: '' };
    block.text += delta; this.blocks.set(index, block);
    if (delta) this.emit({ type: 'message_update', usage, assistantMessageEvent: { type: `${type}_delta`, contentIndex: index, delta } });
  }
  private reconcile(message: AssistantMessage) {
    this.begin(message);
    message.content.forEach((block, index) => {
      if (block.type !== 'text' && block.type !== 'thinking') return;
      const full = block.type === 'text' ? block.text : block.thinking;
      const previous = this.blocks.get(index)?.text ?? '';
      if (!full.startsWith(previous)) throw new Error('Remote stream changed an already emitted prefix');
      this.delta(index, block.type, full.slice(previous.length), message.usage);
    });
  }
  private entry(entry: EntryRecord) {
    if (this.seen.has(String(entry.id))) return;
    this.seen.add(String(entry.id));
    for (const message of entry.model ?? []) {
      if (message.role !== 'assistant') continue;
      this.reconcile(message);
      this.emit({ type: 'message_end', message });
      this.active = false; this.blocks.clear();
    }
  }
  snapshot(snapshot: SnapshotEvent) {
    snapshot.entries.forEach(entry => this.entry(entry));
    if (snapshot.generation?.message) this.reconcile(snapshot.generation.message);
    for (const tool of snapshot.tools) {
      if (tool.status !== 'done' && !this.tools.has(tool.callId)) {
        this.tools.add(tool.callId);
        this.emit({ type: 'tool_execution_start', toolCallId: tool.callId, toolName: tool.name, args: {} });
      }
    }
  }
  events(events: readonly AgentEvent[]) {
    for (const event of events) {
      switch (event.type) {
        case 'snapshot': this.snapshot(event); break;
        case 'message_start': if (event.message.role === 'assistant') this.reconcile(event.message); break;
        case 'message_update':
          for (const change of event.changes) {
            if (change.type === 'text_delta' || change.type === 'thinking_delta') this.delta(change.contentIndex, change.type === 'text_delta' ? 'text' : 'thinking', change.delta, event.usage);
            else if (change.type === 'message') this.reconcile(change.message);
            else if (['block', 'text_start', 'thinking_start'].includes(change.type) && 'block' in change && (change.block.type === 'text' || change.block.type === 'thinking')) {
              const text = change.block.type === 'text' ? change.block.text : change.block.thinking;
              const previous = this.blocks.get(change.contentIndex)?.text ?? '';
              if (!text.startsWith(previous)) throw new Error('Remote stream changed an already emitted prefix');
              this.delta(change.contentIndex, change.block.type, text.slice(previous.length), event.usage);
            }
          } break;
        case 'message_end': this.entry(event.entry); break;
        case 'tool_execution_start': this.tools.add(event.toolCallId); this.emit(event); break;
        case 'tool_execution_update': this.emit({ ...event, partialResult: { content: [{ type: 'text', text: 'append' in (event.output ?? {}) ? (event.output as { append: string }).append : (event.output as { set?: string } | undefined)?.set ?? '' }], details: event.details } }); break;
        case 'tool_execution_end': {
          const result = event.entry?.model?.find(m => m.role === 'toolResult');
          this.emit({ ...event, result: result ? { content: result.content, details: result.details } : { content: [] }, isError: result?.isError ?? !event.entry });
          this.tools.delete(event.toolCallId); break;
        }
        case 'auto_retry_start': this.emit({ ...event, delayMs: Math.max(0, event.at - Date.now()) }); break;
        case 'auto_retry_end': this.emit(event); break;
        case 'task_failed': this.emit({ type: 'extension_error', extensionPath: 'pi-durable', event: event.kind, error: event.message }); break;
      }
    }
  }
  finish(entries: readonly EntryRecord[]) { entries.forEach(e => this.entry(e)); }
}
