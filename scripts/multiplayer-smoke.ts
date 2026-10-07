import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:8796",
  owner = "local-multiplayer-owner";
const dir = mkdtempSync(join(tmpdir(), "hm-multiplayer-"));
let worker: ReturnType<typeof spawn> | undefined;
let logs = "";
async function start() {
  logs = "";
  worker = spawn(
    "node_modules/.bin/wrangler",
    [
      "dev",
      "--config",
      "wrangler.execution.jsonc",
      "--local",
      "--port",
      "8796",
      "--inspector-port",
      "9236",
      "--persist-to",
      dir,
      "--var",
      "LOCAL_TEST:true",
      "--var",
      `DEMO_TOKEN:${owner}`,
    ],
    { detached: true, stdio: "pipe" },
  );
  worker.stdout!.on("data", (d) => (logs += d));
  worker.stderr!.on("data", (d) => (logs += d));
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/health")).ok) return;
    } catch {}
    if (worker.exitCode !== null) throw Error(logs.slice(-3000));
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Startup timed out");
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const p = worker,
    done = new Promise<void>((r) => p.once("exit", () => r()));
  process.kill(-p.pid!, "SIGTERM");
  await done;
  worker = undefined;
}
async function request(path: string, body?: unknown, token = owner) {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
}
async function api(path: string, body?: unknown, token = owner): Promise<any> {
  const r = await request(path, body, token);
  assert.ok(r.ok, `${path}: ${r.status} ${await r.clone().text()}`);
  return r.json();
}
try {
  await start();
  assert.match(
    await (await fetch(base + "/multiplayer")).text(),
    /Shared agent projects/,
  );
  await api("/admin/projects", { project: "test", title: "Shared project" });
  await api("/admin/projects", {
    project: "private",
    title: "Private project",
  });
  const editor = await api("/projects/test/members", {
    id: "editor",
    label: "Editor",
    role: "editor",
  });
  const viewer = await api("/projects/test/members", {
    id: "viewer",
    label: "Viewer",
    role: "viewer",
  });
  const a = await api("/projects/test/agents", {
      label: "builder",
      purpose: "Build",
    }),
    b = await api("/projects/test/agents", {
      label: "reviewer",
      purpose: "Review",
    });
  assert.equal(
    (await request("/projects/private/board", undefined, editor.token)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/admin/billing/resume",
        { confirm: "RESUME BILLABLE WORK" },
        editor.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/projects/test/agents",
        { label: "bad", purpose: "Bad" },
        editor.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/projects/test/tasks",
        { id: "bad", agent: a.id, instruction: "Bad" },
        viewer.token,
      )
    ).status,
    403,
  );
  const note = await api(
    "/projects/test/notes",
    { id: "decision", content: "SQLite is the approved database." },
    editor.token,
  );
  const one = await api(
    "/projects/test/tasks",
    {
      id: "build",
      agent: a.id,
      instruction:
        "workspace-fixture:" +
        JSON.stringify({
          tool: "team_note",
          args: { id: "built", content: "Builder completed the schema." },
        }),
    },
    editor.token,
  );
  const two = await api(
    "/projects/test/tasks",
    {
      id: "review",
      agent: b.id,
      instruction:
        "workspace-fixture:" + JSON.stringify({ tool: "team_board", args: {} }),
    },
    editor.token,
  );
  const dispatched = await Promise.all([
    api("/projects/test/run", { id: one.id }, editor.token),
    api("/projects/test/run", { id: two.id }, editor.token),
  ]);
  assert.equal(dispatched[0].task.state, "running");
  const restricted = await api("/projects/test/agents", {
    label: "observer",
    purpose: "Read shared evidence only",
    allowedTools: ["team_board"],
  });
  const restrictedChat = await api(
    `/api/${restricted.id}/chat`,
    {
      message:
        "workspace-fixture:" +
        JSON.stringify({
          tool: "exec",
          args: { command: "export default () => 42" },
        }),
      operationId: crypto.randomUUID(),
    },
    editor.token,
  );
  const restrictedMessages = await api(
    `/api/${restricted.id}/rpc`,
    { type: "get_messages" },
    editor.token,
  );
  assert.ok(
    restrictedMessages.messages.some(
      (m: any) => m.role === "toolResult" && m.toolName === "exec" && m.isError,
    ),
  );
  assert.ok(
    !(await api("/admin/billing/status")).reservations.some(
      (r: any) => r.kind === "executions" && r.used > 0,
    ),
    "Denied tools must never reach the execution backend",
  );

  for (const task of [one, two]) {
    let current;
    for (let i = 0; i < 50; i++) {
      current = await api(
        "/projects/test/refresh",
        { id: task.id },
        viewer.token,
      );
      if (current.state !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(current.state, "done");
  }
  const board = await api("/projects/test/board", undefined, viewer.token);
  assert.ok(
    board.notes.some((n: any) => n.content === "Builder completed the schema."),
  );
  assert.equal(board.tasks.length, 2);
  const old = await api(`/api/${a.id}/debug`, undefined, viewer.token);
  assert.equal(
    (await request(`/api/${a.id}/rpc`, { type: "abort" }, viewer.token)).status,
    403,
  );
  await api(
    "/projects/test/notes",
    { id: "later", content: "A later note must not alter history." },
    editor.token,
  );
  assert.deepEqual(
    (await api(`/api/${a.id}/debug`, undefined, viewer.token)).transcript,
    old.transcript,
  );
  const isolated = await api("/api/outside/debug");
  assert.equal(
    (await request("/api/outside/debug", undefined, editor.token)).status,
    403,
  );
  await stop();
  await start();
  const recovered = await api("/projects/test/board", undefined, editor.token);
  assert.deepEqual(
    recovered,
    await api("/projects/test/board", undefined, viewer.token),
  );
  assert.equal(recovered.tasks.length, 2);
  assert.deepEqual(
    (await api(`/api/${a.id}/debug`, undefined, viewer.token)).transcript,
    old.transcript,
  );
  await api("/projects/test/revoke", { id: editor.id });
  assert.equal(
    (await request("/projects/test/board", undefined, editor.token)).status,
    403,
  );
  await api("/admin/billing/stop", {});
  assert.equal(
    (
      await request(
        "/projects/test/notes",
        { id: "stopped", content: "No work" },
        owner,
      )
    ).status,
    503,
  );
  assert.equal((await api("/admin/billing/status")).stopped, true);
  await api('/projects/test/revoke',{id:viewer.id});
  assert.equal((await request('/projects/test/board',undefined,viewer.token)).status,403);
  await stop();
  await start();
  assert.equal((await api("/admin/billing/status")).stopped, true);
  console.log(
    "PASS: real workerd multiplayer credentials/isolation/revocation, parallel Pi task dispatch, shared handoffs, immutable prefix, restart persistence and owner-only persistent emergency stop.",
  );
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
