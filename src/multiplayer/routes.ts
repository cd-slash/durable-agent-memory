import type { Env } from "../agent";
import { sha256 } from "../core/hierarchy";
import type { TeamTask, Actor } from "./store";
export async function teamCall(
  control: DurableObjectStub,
  action: string,
  body: unknown,
) {
  return control.fetch("https://billing/team/" + action, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
export async function projectRoutes(
  request: Request,
  env: Env,
  control: DurableObjectStub,
  owner: boolean,
  hash: string,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const isAdmin = url.pathname === "/admin/projects";
  const match = url.pathname.match(
    /^\/projects\/([a-zA-Z0-9_-]{1,40})\/(board|members|revoke|agents|tasks|run|refresh|cancel|notes)$/,
  );
  if (!isAdmin && !match) return undefined;
  if (isAdmin) {
    if (!owner)
      return Response.json({ error: "Owner access required" }, { status: 403 });
    if (request.method === "GET") return teamCall(control, "list", { owner });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
  }
  if (match) {
    const auth = await teamCall(control, "auth", {
      project: match[1],
      owner,
      hash,
    });
    if (!auth.ok) return auth;
  }
  if (match?.[2] === 'revoke') {
    if (!owner) return Response.json({error:'Owner access required'},{status:403});
    if (request.method !== 'POST') return new Response('Method not allowed',{status:405});
    const raw = await request.text(); if (new TextEncoder().encode(raw).length > 500) return new Response('Payload too large',{status:413});
    let input: {id?:unknown};try{input=JSON.parse(raw);}catch{return new Response('Invalid JSON',{status:400});}
    if(typeof input?.id !== 'string' || input.id.length > 90) return new Response('Invalid member id',{status:400});
    return teamCall(control,'revoke',{project:match[1],owner,hash,id:input.id});
  }
  const permit = await control.fetch("https://billing/reserve", {
    method: "POST",
    body: JSON.stringify({ requests: 1, storageBytes: 4096 }),
  });
  if (!permit.ok) return permit;
  if (Number(request.headers.get("content-length") ?? 0) > 16000)
    return new Response("Payload too large", { status: 413 });
  const raw = request.method === "POST" ? await request.text() : "";
  if (new TextEncoder().encode(raw).length > 16000)
    return new Response("Payload too large", { status: 413 });
  let body: Record<string, any>;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // Copy only accepted fields: public requests cannot supply owner/hash/internalAgent authority.
  const auth = { project: match?.[1], owner, hash };
  if (isAdmin)
    return teamCall(control, "create", {
      owner,
      project: body.project,
      title: body.title,
    });
  const action = match![2];
  if (action === "board" && request.method === "GET")
    return teamCall(control, "board", auth);
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (action === "members") {
    const token = `mp_${crypto.randomUUID()}_${crypto.randomUUID()}`;
    const r = await teamCall(control, "member", {
      ...auth,
      id: body.id,
      label: body.label,
      role: body.role,
      tokenHash: await sha256(token),
    });
    return r.ok
      ? Response.json(
          { ...((await r.json()) as object), token },
          { status: 201, headers: { "cache-control": "no-store" } },
        )
      : r;
  }
  if (action === "revoke")
    return teamCall(control, "revoke", { ...auth, id: body.id });
  if (action === "agents")
    return teamCall(control, "agent", {
      ...auth,
      label: body.label,
      purpose: body.purpose,
      allowedTools: body.allowedTools,
    });
  if (action === "tasks")
    return teamCall(control, "new-task", {
      ...auth,
      id: body.id,
      agent: body.agent,
      instruction: body.instruction,
    });
  if (action === "notes")
    return teamCall(control, "note", {
      ...auth,
      id: body.id,
      content: body.content,
    });
  const actorResponse = await teamCall(control, "auth", auth);
  if (!actorResponse.ok) return actorResponse;
  const actor = (await actorResponse.json()) as Actor;
  if (action !== "refresh" && actor.role !== "editor")
    return Response.json({ error: "Project is read only" }, { status: 403 });
  const lookup = await teamCall(control, "task", { ...auth, id: body.id });
  if (!lookup.ok) return lookup;
  const task = (await lookup.json()) as TeamTask | null;
  if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
  if (action === "run" || task.state === "running") {
    const admitted = await control.fetch("https://billing/agent", {
      method: "POST",
      body: JSON.stringify({ agent: task.agent }),
    });
    if (!admitted.ok) return admitted;
  }
  const agent = env.AGENTS.get(env.AGENTS.idFromName(task.agent));
  if (action === "run") {
    const claimResponse = await teamCall(control, "claim", {
      ...auth,
      id: task.id,
    });
    if (!claimResponse.ok) return claimResponse;
    const claim = (await claimResponse.json()) as TeamTask & {
      claimed: boolean;
    };
    if (!claim.claimed) return Response.json({ task: claim, replayed: true });
    const turn = await control.fetch("https://billing/turn", {
      method: "POST",
      body: JSON.stringify({ agent: task.agent }),
    });
    if (!turn.ok) return turn;
    const storage = await control.fetch("https://billing/reserve", {
      method: "POST",
      body: JSON.stringify({
        storageBytes:
          (new TextEncoder().encode(task.instruction).length + 12000) * 16,
      }),
    });
    if (!storage.ok) return storage;
    const response = await agent.fetch("https://agent/submit", {
      method: "POST",
      headers: { "x-hm-agent": task.agent, "x-hm-member": task.createdBy },
      body: JSON.stringify({
        message: task.instruction,
        operationId: task.operationId,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      return Response.json(
        {
          error:
            "Task dispatch failed; inspect and explicitly recover the same task",
          task: claim,
        },
        { status: 502 },
      );
    return Response.json(
      { task: claim, receipt: await response.json() },
      { status: 202 },
    );
  }
  if (action === "cancel") {
    if (!["pending", "running"].includes(task.state))
      return Response.json(task);
    if (task.state === "running")
      await agent.fetch("https://agent/rpc", {
        method: "POST",
        body: JSON.stringify({ type: "abort", operationId: task.operationId }),
        signal: AbortSignal.timeout(20000),
      });
    return teamCall(control, "settle", {
      ...auth,
      id: task.id,
      state: "cancelled",
      result: "Cancelled by project editor",
    });
  }
  if (task.state !== "running") return Response.json(task);
  const result = await agent.fetch(
    "https://agent/task-result?operationId=" +
      encodeURIComponent(task.operationId),
  );
  if (!result.ok) return result;
  const outcome = (await result.json()) as {
    pending?: boolean;
    status?: string;
    text?: string;
  };
  if (outcome.pending) return Response.json(task);
  // Viewer observations may settle a known Pi result but may not invent or mutate task output.
  return teamCall(control, "settle", {
    ...auth,
    owner: true,
    id: task.id,
    state: outcome.status === "done" ? "done" : "failed",
    result: outcome.text ?? "",
  });
}
