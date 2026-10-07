import { DurableObject } from 'cloudflare:workers';
import { durableObjectDriver } from '../storage/durable-sqlite';
import { ProjectStore } from '../multiplayer/store';
import { projectControl } from '../multiplayer/control';
import { SandboxLeases } from '../sandbox/leases';
import { SANDBOX, SANDBOX_ACTIVATION_BLOCK } from '../sandbox/policy';
import { BillingLedger } from './ledger';
import { BillingBlocked, MAX_AGENTS, type Reservation } from './policy';
interface ControlEnv { AGENTS: DurableObjectNamespace; SANDBOX?: DurableObjectNamespace; SANDBOX_ENABLED?: string }
export class BillingControl extends DurableObject<ControlEnv> {
  readonly projects = new ProjectStore(durableObjectDriver(this.ctx.storage));
  readonly ledger = new BillingLedger(durableObjectDriver(this.ctx.storage));
  readonly sandbox = new SandboxLeases(durableObjectDriver(this.ctx.storage), this.ledger);
  constructor(ctx: DurableObjectState, env: ControlEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS billing_agents(name TEXT PRIMARY KEY,last_turn INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS billing_known_agents(name TEXT PRIMARY KEY)');
  }
  async abortRegistered() {
    const names = [...this.ctx.storage.sql.exec<{name: string}>('SELECT name FROM billing_agents ORDER BY last_turn DESC LIMIT 300')];
    for (let i = 0; i < names.length; i += 5) await Promise.allSettled(names.slice(i, i + 5).map(({name}) => this.env.AGENTS.get(this.env.AGENTS.idFromName(name)).fetch('https://agent/billing-stop', { method: 'POST' })));
  }
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname;
    try {
      if (action.startsWith('/team/') && request.method === 'POST') return projectControl(request, this.projects, this.ledger);
      if (action === '/status' && request.method === 'GET') return Response.json({ ...this.ledger.status(), sandbox: { enabled: this.env.SANDBOX_ENABLED === 'true' && !SANDBOX_ACTIVATION_BLOCK, activationBlock: SANDBOX_ACTIVATION_BLOCK, lease: this.sandbox.status() ?? null, limits: SANDBOX } });
      if (action.startsWith('/sandbox/')) {
        if (action === '/sandbox/status' && request.method === 'GET') return Response.json({ lease: this.sandbox.status() ?? null });
        if (request.method !== 'POST') return new Response('Not found', { status: 404 });
        const body = await request.json() as {agent?:string;operationId?:string;token?:string;bytes?:number};
        if (action === '/sandbox/failure') {this.ledger.stop('Sandbox cleanup unconfirmed; explicit owner stop/inspection required'); return Response.json({stopped:true});}
        if (action === '/sandbox/release' && typeof body.token === 'string') {this.sandbox.release(body.token);return Response.json({released:true});}
        if (this.env.SANDBOX_ENABLED !== 'true' || !this.env.SANDBOX) throw new BillingBlocked('Sandbox disabled pending owner cost approval');
        if (action === '/sandbox/acquire') {
          if (SANDBOX_ACTIVATION_BLOCK) throw new BillingBlocked(SANDBOX_ACTIVATION_BLOCK);
          if (!body.agent || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.agent) || !body.operationId || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.operationId) || ![...this.ctx.storage.sql.exec('SELECT name FROM billing_known_agents WHERE name=?',body.agent)].length) throw new BillingBlocked('Unknown sandbox agent');
          const projectAgent = this.projects.agent(body.agent);
          if (projectAgent && !projectAgent.allowedTools.includes('shell')) throw new BillingBlocked('Shell denied by project policy');
          return Response.json(this.sandbox.acquire(body.agent,body.operationId));
        }
        if (action === '/sandbox/active' && body.token) {this.sandbox.assertActive(body.token);return Response.json({allowed:true});}
        if (action === '/sandbox/network' && body.token) {this.sandbox.network(body.token,body.bytes!);return Response.json({allowed:true});}
        return new Response('Not found',{status:404});
      }
      if (action === '/sessions' && request.method === 'GET') return Response.json({ sessions: [...this.ctx.storage.sql.exec<{name: string;last_turn: number}>('SELECT name,last_turn FROM billing_agents ORDER BY last_turn DESC LIMIT 50')] });
      if (action === '/inspect' && request.method === 'GET') {
        const agent = new URL(request.url).searchParams.get('agent') ?? '';
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agent) || ![...this.ctx.storage.sql.exec('SELECT name FROM billing_known_agents WHERE name=?', agent)].length) return Response.json({ error: 'Unknown registered agent' }, { status: 404 });
        return this.env.AGENTS.get(this.env.AGENTS.idFromName(agent)).fetch('https://agent/billing-inspect');
      }
      if (request.method !== 'POST') return new Response('Not found', { status: 404 });
      if (action === '/stop') { const alreadyStopped = this.ledger.status().stopped; this.ledger.stop('Owner emergency stop'); if (!alreadyStopped) this.ctx.waitUntil(this.abortRegistered()); if (this.env.SANDBOX) this.ctx.waitUntil(this.env.SANDBOX.getByName('project-coding-v1').fetch('https://sandbox/stop',{method:'POST'}).then(()=>{}).catch(()=>{})); return Response.json({ ...this.ledger.status(), cancellation: 'bounded best-effort agent abort and singleton container destruction requested' }); }
      if (action === '/resume') {
        const body = await request.json() as { confirm?: string };
        if (body.confirm !== 'RESUME BILLABLE WORK') return Response.json({ error: 'Explicit resume confirmation required' }, { status: 400 });
        this.ledger.resume(); return Response.json(this.ledger.status());
      }
      if (action === '/agent') {
        const { agent } = await request.json() as { agent?: string };
        if (!agent || !/^[a-zA-Z0-9_-]{1,64}$/.test(agent)) return new Response('Invalid agent', { status: 400 });
        if (this.ledger.status().stopped) throw new BillingBlocked();
        if (![...this.ctx.storage.sql.exec('SELECT name FROM billing_known_agents WHERE name=?', agent)].length) {
          const count = this.ctx.storage.sql.exec<{count: number}>('SELECT COUNT(*) AS count FROM billing_known_agents').one().count;
          if (count >= MAX_AGENTS) { this.ledger.stop('Lifetime agent-object quota reached'); throw new BillingBlocked(); }
          this.ctx.storage.sql.exec('INSERT INTO billing_known_agents VALUES(?)', agent);
        }
        return Response.json({ allowed: true });
      }
      if (action === '/turn') {
        const body = await request.json() as { agent?: string };
        if (!body.agent || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.agent)) return new Response('Invalid agent', { status: 400 });
        this.ledger.reserve({ turns: 1 });
        this.ctx.storage.sql.exec('DELETE FROM billing_agents WHERE last_turn<?', Date.now() - 31 * 86400000);
        this.ctx.storage.sql.exec('INSERT INTO billing_agents VALUES(?,?) ON CONFLICT(name) DO UPDATE SET last_turn=excluded.last_turn', body.agent, Date.now());
        return Response.json({ allowed: true });
      }
      if (action === '/reserve') { this.ledger.reserve(await request.json() as Reservation); return Response.json({ allowed: true }); }
      return new Response('Not found', { status: 404 });
    } catch (error) { return Response.json({ error: error instanceof BillingBlocked ? error.reason : 'Billing control unavailable' }, { status: 503 }); }
  }
}
export class BillingClient {
  private readonly control: DurableObjectStub;
  constructor(namespace: DurableObjectNamespace) { this.control = namespace.get(namespace.idFromName('project-global-v1')); }
  async reserve(reservation: Reservation) {
    const response = await this.control.fetch('https://billing/reserve', { method: 'POST', body: JSON.stringify(reservation) });
    if (!response.ok) throw new BillingBlocked();
  }
  async status(): Promise<{ stopped: boolean }> {
    const response = await this.control.fetch('https://billing/status');
    if (!response.ok) throw new BillingBlocked('Billing status unavailable');
    return response.json();
  }
  async assertRunning() { if ((await this.status()).stopped) throw new BillingBlocked(); }
}
