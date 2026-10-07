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
import { piAIBinding } from './pi/workers-ai-binding';
import { remoteRpc, remoteSubmit, operationStream } from './pi/remote';
import type { ContextInput, RememberInput, SearchInput } from './core/types';
import { tailnetExtension } from './tailnet/extension';
import { shellExtension } from './sandbox/extension';
import { createWorkspace, workspaceExtension } from './execution/workspace';
import { DEFAULT_WEB_HOSTS, webExtension } from './web/tools';
import { BillingClient } from './billing/control';
import { guardedAI } from './billing/ai-binding';
import { BillingBlocked } from './billing/policy';
import { projectExtension, projectSnapshot, guardProjectTools } from './multiplayer/extension';
import { turnBudgetExtension, reservePreparedTurnRequest } from './pi/turn-budget';
export interface Env {
  AGENTS: DurableObjectNamespace<MemoryAgent>; AI: Ai; MODEL: string;
  LOADER?: WorkerLoader;
  SANDBOX?: DurableObjectNamespace;
  SANDBOX_ENABLED?: string;
  TAILNET?: DurableObjectNamespace;
  TAILNET_ENABLED?: string;
  TAILNET_TARGETS?: string;
  TAILSCALE_AUTH_KEY?: string;
  BILLING: DurableObjectNamespace;
  WEB_ALLOWED_HOSTS?: string;
  /** Local-only switch. Real deployment always uses Workers AI. */
  LOCAL_TEST?: string;
  DEMO_TOKEN?: string;
}
export class MemoryAgent extends DurableObject<Env> {
  readonly modelId = this.env.MODEL;
  readonly bootId = crypto.randomUUID();
  readonly sql = durableObjectDriver(this.ctx.storage);
  readonly store = new DurableSqliteStore(this.sql);
  readonly projectControl = this.env.BILLING.get(this.env.BILLING.idFromName('project-global-v1'));
  projectName() { return this.sql.all<{name:string}>('SELECT name FROM hm_agent_identity WHERE id=1')[0]?.name ?? ''; }
  readonly billing = new BillingClient(this.env.BILLING);
  readonly billedAI = guardedAI(this.env.AI, this.billing);
  readonly memory = new HybridMemory({ store: this.store,
    beforeWrite: async input => {
      if (new TextEncoder().encode(JSON.stringify(input)).length > 16384) throw new BillingBlocked('Memory exceeds billing-safe write size');
      await this.billing.reserve({ memories: 1, storageBytes: new TextEncoder().encode(JSON.stringify(input)).length * 16 });
    },
    embeddings: this.env.LOCAL_TEST === 'true' ? undefined : new WorkersAIEmbeddings(this.billedAI as unknown as import('./embeddings/workers-ai').AIBinding),
    summarizer: this.env.LOCAL_TEST === 'true' ? new ExtractiveSummarizer() : new WorkersAISummarizer(this.billedAI as unknown as import('./embeddings/workers-ai').AIBinding, this.env.MODEL),
  });
  readonly jobs = new MemoryJobs(this.memory, this.billing);
  readonly local = this.env.LOCAL_TEST === 'true' ? localProvider() : undefined;
  readonly ai = createAI({ binding: piAIBinding(guardedAI(this.env.AI, this.billing, () => reservePreparedTurnRequest(this.sql))) });
  readonly tailnetGateway=this.env.TAILNET?.getByName('project-tailnet-v1');
  tailnetTargets(){return this.env.TAILNET_TARGETS;}
  readonly codingSandbox = this.env.SANDBOX?.getByName('project-coding-v1');
  readonly registry = createRegistry();
  readonly workspace = createWorkspace(this.ctx.storage, this.env.LOADER);
  readonly webHosts = this.env.WEB_ALLOWED_HOSTS?.split(',').map(host => host.trim()).filter(Boolean) ?? DEFAULT_WEB_HOSTS;
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install(guardProjectTools(memoryExtension(this.memory, () => this.jobs.enqueue(), () => this.billing.reserve({ tools: 1 })), this));
      await this.workspace.fs.mkdir('/workspace', { recursive: true });
      this.registry.install(guardProjectTools(workspaceExtension(this.workspace, !!this.env.LOADER, this.billing), this));
      this.registry.install(guardProjectTools(webExtension(this.webHosts, this.billing), this));
      this.registry.install(guardProjectTools(projectExtension(this), this));
      if (this.env.SANDBOX && this.env.SANDBOX_ENABLED === 'true') this.registry.install(guardProjectTools(shellExtension(this), this));
      if(this.env.TAILNET && this.env.TAILNET_ENABLED==='true')this.registry.install(guardProjectTools(tailnetExtension(this),this));
      this.registry.install(turnBudgetExtension(this.sql));
      const models = createModels(); models.setProvider(this.local ? new Proxy(this.local.provider, { get: (target, key) => {
        if (key === 'streamSimple') return (...args: unknown[]) => { reservePreparedTurnRequest(this.sql); return Reflect.apply(target.streamSimple, target, args); };
        return Reflect.get(target, key);
      } }) : this.ai.provider);
      return Harness.open(storage, { models, registry: this.registry, settings: { retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } }, onReport: () => console.warn('pi_report') }, context);
    },
    defaults: { model: this.local?.getModel() ?? this.ai(this.env.MODEL, { streamIdleTimeoutMs: 15000 }), thinkingLevel: 'off' },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.jobs);
  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      this.sql.run('CREATE TABLE IF NOT EXISTS hm_agent_identity(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL)');
      const identity = request.headers.get('x-hm-agent');
      if (identity && /^[a-zA-Z0-9_-]{1,64}$/.test(identity) && this.ctx.id.equals(this.env.AGENTS.idFromName(identity))) this.sql.run('INSERT OR IGNORE INTO hm_agent_identity VALUES(1,?)', identity);
      if (request.method === 'POST' && path === '/billing-stop') { await this.harness.session().abort(); return Response.json({ aborted: true }); }
      if (request.method === 'GET' && path === '/billing-inspect') {
        const messages = (await this.harness.messages()).flatMap(entry => entry.model ?? []);
        const tools = messages.filter(message => message.role === 'toolResult' || (message.role === 'assistant' && message.content.some(block => block.type === 'toolCall'))).slice(-12);
        return Response.json({ bootId: this.bootId, tools: tools.map(message => JSON.stringify(message).slice(0, 12000)) });
      }
      await this.billing.assertRunning();
      if (request.method === 'GET' && path === '/task-result') {
        const operationId = new URL(request.url).searchParams.get('operationId') ?? '';
        if (!this.sql.all('SELECT id FROM hm_submissions WHERE id=?',operationId).length) return Response.json({error:'Unknown operation'},{status:404});
        try {
          const result = await this.harness.session().wait(operationId,AbortSignal.timeout(250));
          return Response.json({status:result.status,text:result.status==='done'?(result.text??'').slice(0,6000):'Pi task ended without a completed answer'});
        } catch { return Response.json({pending:true}); }
      }
      if (request.method === 'GET' && path === '/events') return await operationStream(this, new URL(request.url).searchParams.get('operationId') ?? '');
      if (request.method === 'GET' && path === '/debug') return Response.json({ bootId: this.bootId, capabilities: { execution: this.env.LOADER ? 'isolated-javascript' : 'disabled-requires-worker-loader', workspace: '/workspace', shell: this.env.SANDBOX && this.env.SANDBOX_ENABLED === 'true' ? 'cloudflare-linux-private-checkpoint' : 'disabled-pending-cost-approval', webFetchHosts: this.webHosts, webSearch: false }, events: this.store.events(), nodes: this.store.nodes(), pending: this.memory.pending(), embeddingModels: this.sql.all('SELECT model,version,COUNT(*) AS count FROM hm_embeddings GROUP BY model,version'), localTest: this.env.LOCAL_TEST === 'true', transcript: await this.harness.messages(), epochs: this.sql.all('SELECT * FROM hm_epochs') });
      if (request.method === 'GET' && path === '/read') return Response.json(await this.memory.read(new URL(request.url).searchParams.get('id') ?? ''));
      if (request.method === 'GET' && path === '/expand') return Response.json(await this.memory.expand(new URL(request.url).searchParams.get('id') ?? ''));
      if (request.method !== 'POST') return new Response('Not found', { status: 404 });
      const body = await request.json() as Record<string, unknown>;
      if (path === '/rpc') return Response.json(await remoteRpc(this, body));
      if (path === '/submit') return Response.json(await remoteSubmit(this, body, request.headers.get('x-hm-member') ?? 'owner'));
      if (path === '/remember') {
        const event = await this.memory.remember(body as unknown as RememberInput);
        await this.jobs.enqueue();
        return Response.json(event, { status: 201 });
      }
      if (path === '/search') return Response.json(await this.memory.search(body as unknown as SearchInput));
      if (path === '/context') return Response.json(await this.memory.context(body as unknown as ContextInput));
      if (path === '/compact') return Response.json(await this.memory.compact({ maxWork: 8 }));
      if (path === '/chat') {
        if (typeof body.message !== 'string') throw new Error('message is required');
        const operationId = typeof body.operationId === 'string' ? body.operationId : crypto.randomUUID();
        const frozen = await prepareTurn(this.memory, this.sql, body.message, operationId, {}, await projectSnapshot(this), request.headers.get('x-hm-member') ?? 'owner');
        const answer = await this.harness.prompt(frozen.input, { operationId });
        return Response.json({ ...answer, retrieval: frozen.context });
      }
      if (path === '/reset') {
        const session = this.harness.session();
        if (await session.busy()) return Response.json({ error: 'Wait for the active Pi run before resetting' }, { status: 409 });
        const transcript = await session.messages();
        if (transcript.length) await retainTranscript(this.memory, transcript, await sha256(JSON.stringify(transcript)));
        await this.jobs.enqueue();
        await this.memory.compact({ maxWork: 8 });
        const query = typeof body.query === 'string' ? body.query : '';
        const handoff = await this.memory.context({ query, maxTokens: 4000, includeRecent: true });
        await session.reset(handoff.text || undefined);
        this.sql.run('INSERT INTO hm_epochs(created_at,handoff) VALUES(?,?)', Date.now(), handoff.text);
        return Response.json({ reset: true, handoff });
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof BillingBlocked) return Response.json({ error: error.reason }, { status: 503 });
      // Return known validation errors only; never echo provider responses or submitted content.
      const message = error instanceof Error ? error.message : '';
      const safe = /^(Memory not found|Invalid (prompt|query|kind|namespace|idempotency|includeRecent)|Memory content|Idempotency key|operationId|maxTokens|limit must|Weights must|message is required|Unsupported remote|Cannot change model|This deployment supports|Images are not supported)/.test(message);
      console.warn(safe ? 'hm_invalid_request' : 'hm_request_failed', { category: error instanceof Error && ['AIError', 'SyntaxError', 'TypeError', 'Error'].includes(error.name) ? error.name : 'unknown', reason: ['Empty summary response', 'Invalid structured summary', 'Summarizer returned invalid representations', 'Embedding batch length mismatch', 'Invalid embedding vector'].includes(message) ? message : 'other' });
      return Response.json({ error: safe ? message : 'Request failed; inspect Worker logs for the subsystem error marker' }, { status: safe ? 400 : 500 });
    }
  }
}
