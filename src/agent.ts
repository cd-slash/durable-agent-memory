import { DurableObject } from 'cloudflare:workers';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { createAI } from 'agents/models/pi-ai';
import { HybridMemory } from './core/memory';
import { DurableSqliteStore, durableObjectDriver } from './storage/durable-sqlite';
import { MemoryJobs } from './storage/memory-jobs';
import { WorkersAIEmbeddings } from './embeddings/workers-ai';
import { WorkersAISummarizer } from './summarization/workers-ai';
import { ExtractiveSummarizer } from './summarization/extractive';
import { memoryExtension, prepareTurn, retainTranscript } from './pi/extension';
import { localProvider } from './testing/local-provider';
import { sha256 } from './core/hierarchy';
import type { ContextInput, RememberInput, SearchInput } from './core/types';
export interface Env {
  AGENTS: DurableObjectNamespace<MemoryAgent>; AI: Ai; MODEL: string;
  /** Local-only switch. Real deployment always uses Workers AI. */
  LOCAL_TEST?: string;
  DEMO_TOKEN?: string;
}
export class MemoryAgent extends DurableObject<Env> {
  readonly sql = durableObjectDriver(this.ctx.storage);
  readonly store = new DurableSqliteStore(this.sql);
  readonly memory = new HybridMemory({ store: this.store,
    embeddings: this.env.LOCAL_TEST === 'true' ? undefined : new WorkersAIEmbeddings(this.env.AI as unknown as import('./embeddings/workers-ai').AIBinding),
    summarizer: this.env.LOCAL_TEST === 'true' ? new ExtractiveSummarizer() : new WorkersAISummarizer(this.env.AI as unknown as import('./embeddings/workers-ai').AIBinding, this.env.MODEL),
  });
  readonly jobs = new MemoryJobs(this.memory);
  readonly local = this.env.LOCAL_TEST === 'true' ? localProvider() : undefined;
  readonly ai = createAI({ binding: this.env.AI });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install(memoryExtension(this.memory, () => this.jobs.enqueue()));
      const models = createModels(); models.setProvider(this.local?.provider ?? this.ai.provider);
      return Harness.open(storage, { models, registry: this.registry, settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 } }, onReport: () => console.warn('pi_report') }, context);
    },
    defaults: { model: this.local?.getModel() ?? this.ai(this.env.MODEL), thinkingLevel: 'off' },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.jobs);
  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'GET' && path === '/debug') return Response.json({ events: this.store.events(), nodes: this.store.nodes(), pending: this.memory.pending(), embeddingModels: this.sql.all('SELECT model,version,COUNT(*) AS count FROM hm_embeddings GROUP BY model,version'), localTest: this.env.LOCAL_TEST === 'true', transcript: await this.harness.messages(), epochs: this.sql.all('SELECT * FROM hm_epochs') });
      if (request.method === 'GET' && path === '/read') return Response.json(await this.memory.read(new URL(request.url).searchParams.get('id') ?? ''));
      if (request.method === 'GET' && path === '/expand') return Response.json(await this.memory.expand(new URL(request.url).searchParams.get('id') ?? ''));
      if (request.method !== 'POST') return new Response('Not found', { status: 404 });
      const body = await request.json() as Record<string, unknown>;
      if (path === '/remember') {
        const event = await this.memory.remember(body as unknown as RememberInput);
        await this.jobs.enqueue();
        return Response.json(event, { status: 201 });
      }
      if (path === '/search') return Response.json(await this.memory.search(body as unknown as SearchInput));
      if (path === '/context') return Response.json(await this.memory.context(body as unknown as ContextInput));
      if (path === '/compact') return Response.json(await this.memory.compact());
      if (path === '/chat') {
        if (typeof body.message !== 'string') throw new Error('message is required');
        const operationId = typeof body.operationId === 'string' ? body.operationId : crypto.randomUUID();
        const frozen = await prepareTurn(this.memory, this.sql, body.message, operationId);
        const answer = await this.harness.prompt(frozen.input, { operationId });
        return Response.json({ ...answer, retrieval: frozen.context });
      }
      if (path === '/reset') {
        const session = this.harness.session();
        if (await session.busy()) return Response.json({ error: 'Wait for the active Pi run before resetting' }, { status: 409 });
        const transcript = await session.messages();
        if (transcript.length) await retainTranscript(this.memory, transcript, await sha256(JSON.stringify(transcript)));
        await this.jobs.enqueue();
        await this.memory.compact();
        const query = typeof body.query === 'string' ? body.query : '';
        const handoff = await this.memory.context({ query, maxTokens: 4000, includeRecent: true });
        await session.reset(handoff.text || undefined);
        this.sql.run('INSERT INTO hm_epochs(created_at,handoff) VALUES(?,?)', Date.now(), handoff.text);
        return Response.json({ reset: true, handoff });
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      // Return known validation errors only; never echo provider responses or submitted content.
      const message = error instanceof Error ? error.message : '';
      const safe = /^(Memory not found|Invalid |Memory content|Idempotency key|operationId|maxTokens|limit must|Weights must|message is required)/.test(message);
      console.warn(safe ? 'hm_invalid_request' : 'hm_request_failed');
      return Response.json({ error: safe ? message : 'Request failed; inspect Worker logs for the subsystem error marker' }, { status: safe ? 400 : 500 });
    }
  }
}
