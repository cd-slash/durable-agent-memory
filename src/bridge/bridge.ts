import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { RpcProjector, type RpcRecord } from './projector';
import type { EntryRecord, SnapshotEvent, AgentEvent } from '@earendil-works/pi-durable';
export interface BridgeOptions { url: string; token: string; sessionsDir: string; emit: (event: RpcRecord) => void; fetch?: typeof fetch; toolsDisabled?: boolean }
interface Manifest { version: 1; endpoint: string; agent: string; name?: string; inFlight?: { operationId: string; promptHash: string; baseline: string[] } }
export class DurableRpcBridge {
  private manifest!: Manifest;
  private path!: string;
  private active: Promise<void> | undefined;
  private fetcher: typeof fetch;
  constructor(private options: BridgeOptions, sessionPath?: string) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Bridge endpoint must use HTTPS');
    if (url.username || url.password || url.search || url.hash) throw new Error('Invalid bridge endpoint');
    options.url = url.origin;
    mkdirSync(options.sessionsDir, { recursive: true, mode: 0o700 });
    this.fetcher = options.fetch ?? fetch;
    if (sessionPath) this.switchSession(sessionPath); else this.newSession();
  }
  get sessionFile() { return this.path; }
  private newSession() {
    const agent = `t3-${randomUUID()}`;
    this.manifest = { version: 1, endpoint: this.options.url, agent };
    this.path = join(resolve(this.options.sessionsDir), `${agent}.json`);
    this.save();
  }
  private save() { writeFileSync(this.path, JSON.stringify(this.manifest), { mode: 0o600 }); }
  private switchSession(path: string) {
    const actual = realpathSync(path), root = realpathSync(this.options.sessionsDir);
    if (!actual.startsWith(root + sep)) throw new Error('Session manifest must be inside the bridge sessions directory');
    const manifest = JSON.parse(readFileSync(actual, 'utf8')) as Manifest;
    if (manifest.version !== 1 || manifest.endpoint !== this.options.url || !/^t3-[a-f0-9-]{36}$/.test(manifest.agent)) throw new Error('Invalid session manifest or endpoint mismatch');
    if (manifest.inFlight && (typeof manifest.inFlight.operationId !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.inFlight.promptHash) || !Array.isArray(manifest.inFlight.baseline))) throw new Error('Invalid session pending operation');
    this.manifest = manifest; this.path = actual;
  }
  private async request(action: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetcher(`${this.options.url}/api/${this.manifest.agent}/${action}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Remote API HTTP ${response.status}`);
    return response;
  }
  private async rpc(command: RpcRecord): Promise<any> { return (await this.request('rpc', command)).json(); }
  private response(command: RpcRecord, data?: unknown, error?: string) {
    this.options.emit({ type: 'response', command: command.type, ...(command.id === undefined ? {} : { id: command.id }), success: !error, ...(error ? { error } : data === undefined ? {} : { data }) });
  }
  async handle(command: RpcRecord): Promise<void> {
    try {
      if (typeof command.type !== 'string') throw new Error('RPC type is required');
      switch (command.type) {
        case 'prompt': case 'steer': case 'follow_up': {
          if (this.options.toolsDisabled) throw new Error('Tool-free text generation is not supported by this remote bridge');
          if (this.active) throw new Error('A turn is active; remote steering and follow-ups are not exposed through this bridge yet');
          if (command.images && (!Array.isArray(command.images) || command.images.length)) throw new Error('Images are not supported');
          if (typeof command.message !== 'string' || !command.message.trim()) throw new Error('Message is required');
          if (command.message.startsWith('/')) throw new Error('Local Pi slash commands are not supported by the remote bridge');
          const promptHash = createHash('sha256').update(command.message).digest('hex');
          let pending = this.manifest.inFlight;
          if (pending && pending.promptHash !== promptHash) {
            if (await this.busy()) throw new Error('A turn is active in Cloudflare; abort it or retry the original prompt');
            pending = undefined;
          }
          if (!pending) {
            if (await this.busy()) throw new Error('A turn is active in Cloudflare; abort it before starting another');
            const baseline = await this.rpc({ type: 'get_entries' });
            pending = { operationId: randomUUID(), promptHash, baseline: baseline.entries.map((e: { id: string }) => e.id) };
            this.manifest.inFlight = pending;
            // Persist intent before the network: process death can resume the same operation.
            this.save();
          }
          const operationId = pending.operationId;
          // A lost submit response is retried using exactly the same operation id.
          let accepted = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            try { await this.request('submit', { message: command.message, operationId }); accepted = true; break; }
            catch (error) { if (attempt === 1) throw error; }
          }
          if (!accepted) throw new Error('Submission failed');
          this.options.emit({ type: 'agent_start' });
          const projector = new RpcProjector(this.options.emit, pending.baseline);
          this.active = this.observe(operationId, projector).then(() => { delete this.manifest.inFlight; this.save(); this.response(command); }, (error) => this.response(command, undefined, error instanceof Error && /^(Remote stream changed|Remote operation was unanswered)/.test(error.message) ? error.message : 'Remote observation failed; resume this session to inspect durable state'))
            .finally(() => { this.active = undefined; this.options.emit({ type: 'agent_end', messages: [] }); this.options.emit({ type: 'agent_settled' }); });
          return;
        }
        case 'new_session': case 'switch_session': {
          if (this.active || await this.busy()) throw new Error('Cannot change sessions while a run is active');
          if (command.type === 'new_session') this.newSession();
          else { if (typeof command.sessionPath !== 'string') throw new Error('sessionPath is required'); this.switchSession(command.sessionPath); }
          this.response(command, { cancelled: false }); return;
        }
        case 'set_session_name':
          if (typeof command.name !== 'string' || command.name.length > 1000) throw new Error('Invalid session name');
          this.manifest.name = command.name; this.save(); this.response(command); return;
        case 'get_state': {
          const state = await this.rpc(command);
          this.response(command, { ...state, sessionFile: this.path, sessionId: this.manifest.agent, sessionName: this.manifest.name, isStreaming: !!this.active || state.isStreaming }); return;
        }
        case 'get_session_stats': this.response(command, { ...await this.rpc(command), sessionFile: this.path, sessionId: this.manifest.agent }); return;
        case 'get_available_models': case 'get_commands': case 'get_entries': case 'get_messages': case 'set_model': case 'set_thinking_level': case 'abort':
          this.response(command, await this.rpc(command)); return;
        default: throw new Error(`Unsupported bridge command: ${command.type}`);
      }
    } catch (error) {
      // Only controlled errors: no response bodies, credentials, prompts, or file contents.
      const message = error instanceof Error ? error.message : '';
      const safe = /^(Remote API HTTP|Unsupported bridge command|A turn is active|Images are not|Message is required|Local Pi slash|Cannot change sessions|sessionPath is required|Invalid session|Session manifest|RPC type is required|Tool-free text generation)/.test(message);
      this.response(command, undefined, safe ? message : 'Bridge request failed');
    }
  }
  private async busy() { return (await this.rpc({ type: 'get_state' })).isStreaming; }
  private async observe(operationId: string, projector: RpcProjector) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // This timeout stops observation only; Pi work continues durably.
        const response = await this.request(`events?operationId=${encodeURIComponent(operationId)}`, undefined, AbortSignal.timeout(10 * 60 * 1000));
        const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 4_000_000) throw new Error('Stream frame exceeds limit');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              if (!frame.startsWith('data: ')) continue;
              const event = JSON.parse(frame.slice(6)) as { type: string; snapshot: SnapshotEvent; events: AgentEvent[]; entries: EntryRecord[]; result: { status: string; reason?: string } };
              if (event.type === 'snapshot') projector.snapshot(event.snapshot);
              else if (event.type === 'events') projector.events(event.events);
              else if (event.type === 'result') {
                projector.finish(event.entries);
                if (event.result.status !== 'done' && event.result.reason !== 'aborted') throw new Error('Remote operation was unanswered');
                return;
              } else if (event.type === 'error') throw new Error('Remote observer error');
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch (error) {
        if (error instanceof Error && /changed an already emitted prefix|was unanswered/.test(error.message)) throw error;
      }
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw new Error('Remote event stream unavailable');
  }
  async settled() { await this.active; }
}
