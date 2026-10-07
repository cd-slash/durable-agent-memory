import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { MemoryAgent } from '../agent';
import { prepareTurn } from './extension';

/** Coding-agent RPC projection. Pi entries remain the authoritative records. */
export function rpcEntries(entries: readonly EntryRecord[]) {
  return entries.flatMap(entry => (entry.model ?? []).map((message, i) => ({
    type: 'message', id: `${entry.id}:${i}`, parentId: null, message,
  })));
}
export async function remoteRpc(agent: MemoryAgent, body: Record<string, unknown>): Promise<unknown> {
  const session = agent.harness.session();
  const model = agent.local?.getModel() ?? agent.ai(agent.modelId);
  switch (body.type) {
    case 'get_available_models': return { models: [model] };
    case 'get_commands': return { commands: [] };
    case 'get_state': {
      const stream = await session.events();
      try {
        return { model, thinkingLevel: stream.snapshot.agent.thinkingLevel ?? 'off',
          isStreaming: !!stream.snapshot.run || stream.snapshot.inbox.length > 0, isCompacting: stream.snapshot.compactions.length > 0,
          pendingMessageCount: stream.snapshot.inbox.length, autoCompactionEnabled: false,
          autoRetryEnabled: false, messageCount: rpcEntries(stream.snapshot.entries).length };
      } finally { await stream.stop(); }
    }
    case 'get_messages': return { messages: (await session.messages()).flatMap(e => e.model ?? []) };
    case 'get_entries': {
      const all = rpcEntries(await session.messages());
      const cursor = typeof body.since === 'string' ? all.findIndex(e => e.id === body.since) : -1;
      return { entries: all.map((e, i) => ({ ...e, parentId: all[i - 1]?.id ?? null })).slice(cursor + 1), leafId: all.at(-1)?.id ?? null };
    }
    case 'get_session_stats': {
      const messages = (await session.messages()).flatMap(e => e.model ?? []);
      const usage = messages.filter(m => m.role === 'assistant').reduce((sum, m) => {
        if (m.role === 'assistant') { sum.input += m.usage.input; sum.output += m.usage.output; sum.cacheRead += m.usage.cacheRead; sum.cacheWrite += m.usage.cacheWrite; sum.total += m.usage.totalTokens; }
        return sum;
      }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
      const last = [...messages].reverse().find(m => m.role === 'assistant');
      return { contextUsage: last?.role === 'assistant' && last.usage.totalTokens ? { tokens: last.usage.totalTokens, contextWindow: model.contextWindow } : undefined, userMessages: messages.filter(m => m.role === 'user').length, assistantMessages: messages.filter(m => m.role === 'assistant').length, toolCalls: messages.filter(m => m.role === 'toolResult').length, tokens: usage, cost: messages.reduce((sum, m) => sum + (m.role === 'assistant' ? m.usage.cost.total : 0), 0) };
    }
    case 'set_model':
      if (body.provider !== model.provider || body.modelId !== model.id) throw new Error('Unsupported remote model');
      if (await session.busy()) throw new Error('Cannot change model during a run');
      await session.setModel(model); return model;
    case 'set_thinking_level':
      if (typeof body.level !== 'string' || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.level)) throw new Error('Invalid prompt thinking level');
      if (await session.busy()) throw new Error('Cannot change model settings during a run');
      // The public underlying Harness provides configuration not wrapped by PiSession.
      await (await (await agent.harness.pi()).root(BACKGROUND_CONTEXT)).configure({ thinkingLevel: body.level as ModelThinkingLevel }, BACKGROUND_CONTEXT);
      return { level: body.level };
    case 'abort': return { aborted: await session.abort() };
    default: throw new Error('Unsupported remote RPC command');
  }
}

/** SSE is transport glue, not a second scheduler. Disconnect stops only this observer. */
export async function operationStream(agent: MemoryAgent, operationId: string): Promise<Response> {
  if (!operationId || operationId.length > 512) throw new Error('Invalid operationId');
  // A known frozen submission is required; never wait forever on a random operation.
  if (!agent.sql.all('SELECT id FROM hm_submissions WHERE id=?', operationId).length) return Response.json({ error: 'Unknown operation' }, { status: 404 });
  const session = agent.harness.session(), events = await session.events();
  const encoder = new TextEncoder(), waitAbort = new AbortController();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => { if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); };
      send({ type: 'snapshot', snapshot: events.snapshot });
      events.start(async batch => { send({ type: 'events', events: batch }); });
      const deadline = setTimeout(() => waitAbort.abort(), 120000);
      heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n')); }, 15000);
      void (async () => {
        try {
          const result = await session.wait(operationId, waitAbort.signal);
          // Final entries repair observer overflow/disconnect without regenerating work.
          send({ type: 'result', result, entries: await session.messages() });
        } catch { if (!closed) send({ type: 'error', message: 'Operation observer failed; reconnect with the same operationId' }); }
        finally {
          clearTimeout(deadline);
          if (heartbeat) clearInterval(heartbeat);
          await events.stop();
          if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    async cancel() { closed = true; if (heartbeat) clearInterval(heartbeat); waitAbort.abort(); await events.stop(); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-content-type-options': 'nosniff' } });
}
export async function remoteSubmit(agent: MemoryAgent, body: Record<string, unknown>) {
  if (typeof body.message !== 'string' || typeof body.operationId !== 'string') throw new Error('Invalid prompt or operationId');
  if (body.images !== undefined) throw new Error('Images are not supported by this remote deployment');
  if (body.whenBusy !== undefined && !['steer', 'followUp'].includes(String(body.whenBusy))) throw new Error('Invalid prompt mode');
  const frozen = await prepareTurn(agent.memory, agent.sql, body.message, body.operationId);
  return agent.harness.session().submit(frozen.input, { operationId: body.operationId, whenBusy: body.whenBusy as 'steer' | 'followUp' | undefined });
}
