import { ProjectError, ProjectStore, type Role } from "./store";
import type { BillingLedger } from "../billing/ledger";
/** Called only through the authenticated Worker or trusted DO tools. Never a public handler. */
export async function projectControl(
  request: Request,
  store: ProjectStore,
  ledger: BillingLedger,
): Promise<Response> {
  try {
    const body = (await request.json()) as Record<string, any>;
    const action = new URL(request.url).pathname.slice("/team/".length);
    if (action === "tool-auth") {
      const agent = store.agent(body.agent);
      return Response.json({
        allowed: !agent || agent.allowedTools.includes(body.tool),
      });
    }
    if (action === "context")
      return Response.json(store.context(body.agent) ?? null);
    if (action === "agent-auth") {
      const agent = store.agent(body.agent);
      if (!agent) throw new ProjectError(403, "Project access denied");
      const actor = store.authorize(
        agent.project,
        body.hash,
        body.owner === true,
      );
      return Response.json(actor);
    }
    if (action === "list" || action === "create") {
      if (body.owner !== true)
        throw new ProjectError(403, "Owner access required");
      if (action === "list")
        return Response.json({ projects: store.projects() });
      ledger.reserve({ storageBytes: 8192 });
      return Response.json(store.createProject(body.project, body.title), {
        status: 201,
      });
    }
    const actor = body.internalAgent
      ? (() => {
          const agent = store.requireAgent(body.project, body.internalAgent);
          return {
            owner: false,
            project: agent.project,
            member: agent.id,
            role: "editor" as const,
          };
        })()
      : store.authorize(body.project, body.hash, body.owner === true);
    if (action === "revoke") return Response.json(store.revoke(actor, body.id));
    if (action === "auth") return Response.json(actor);
    if (action === "board") return Response.json(store.board(actor.project));
    if (action === "claim") {
      store.writable(actor);
      return Response.json(store.claim(actor, body.id));
    }
    if (action === "task")
      return Response.json(store.getTask(actor.project, body.id) ?? null);
    if (action === "settle") {
      store.writable(actor);
      if (
        !["done", "failed", "cancelled"].includes(body.state) ||
        typeof body.result !== "string"
      )
        throw new ProjectError(400, "Invalid task result");
      ledger.reserve({ storageBytes: Math.max(4096, body.result.length * 16) });
      return Response.json(
        store.settle(actor.project, body.id, body.state, body.result),
      );
    }
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    ledger.reserve({ storageBytes: Math.max(4096, bytes * 16) });
    switch (action) {
      case "member":
        return Response.json(
          store.member(
            actor,
            body.id,
            body.label,
            body.role as Role,
            body.tokenHash,
          ),
          { status: 201 },
        );
      case "revoke":
        return Response.json(store.revoke(actor, body.id));
      case "agent":
        return Response.json(
          store.addAgent(actor, body.label, body.purpose, body.allowedTools),
          {
            status: 201,
          },
        );
      case "new-task":
        return Response.json(
          store.task(actor, body.id, body.agent, body.instruction),
          { status: 201 },
        );
      case "note":
        return Response.json(store.note(actor, body.id, body.content), {
          status: 201,
        });
      default:
        throw new ProjectError(404, "Project action not found");
    }
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ProjectError
            ? error.message
            : "Project control failed",
      },
      { status: error instanceof ProjectError ? error.status : 503 },
    );
  }
}
