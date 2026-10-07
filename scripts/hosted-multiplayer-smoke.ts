import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.BRIDGE_REMOTE_URL,
  tokenFile = process.env.BRIDGE_TOKEN_FILE;
if (!base?.startsWith("https://") || !tokenFile)
  throw Error("Set BRIDGE_REMOTE_URL and BRIDGE_TOKEN_FILE");
const owner = (await readFile(tokenFile, "utf8")).trim();
const project = "team-demo-" + Date.now();
async function request(path: string, body?: unknown, token = owner) {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(130000),
  });
}
async function api(path: string, body?: unknown, token = owner): Promise<any> {
  const r = await request(path, body, token);
  assert.ok(r.ok, `${path}: HTTP ${r.status}`);
  return r.json();
}
const initial = await api("/admin/billing/status");
assert.equal(
  initial.stopped,
  false,
  "Do not silently resume a stopped service",
);
const used = (s: any, kind: string) =>
  s.reservations.find((r: any) => r.period === s.day && r.kind === kind)
    ?.used ?? 0;
assert.ok(
  initial.limits.neurons.day - used(initial, "neurons") >= 2200,
  "Need reviewed headroom for at most eight conversation requests plus two small query embeddings",
);
try {
  await api("/admin/projects", { project, title: "Multiplayer demo" });
  const editor = await api(`/projects/${project}/members`, {
      id: "editor",
      label: "Demo editor",
      role: "editor",
    }),
    viewer = await api(`/projects/${project}/members`, {
      id: "viewer",
      label: "Demo viewer",
      role: "viewer",
    });
  const builder = await api(`/projects/${project}/agents`, {
      label: "builder",
      purpose: "Publish verified implementation handoffs.",
      allowedTools: ["team_board", "team_note"],
    }),
    reviewer = await api(`/projects/${project}/agents`, {
      label: "reviewer",
      purpose: "Inspect shared evidence and review other agents.",
      allowedTools: ["team_board"],
    });
  const privateFile = process.env.MULTIPLAYER_DEMO_FILE;
  if (privateFile)
    await writeFile(
      privateFile,
      JSON.stringify(
        {
          url: base,
          project,
          editorToken: editor.token,
          viewerToken: viewer.token,
          agents: { builder: builder.id, reviewer: reviewer.id },
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
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
        `/projects/${project}/tasks`,
        { id: "denied", agent: builder.id, instruction: "Denied" },
        viewer.token,
      )
    ).status,
    403,
  );
  async function task(id: string, agent: string, instruction: string) {
    const t = await api(
      `/projects/${project}/tasks`,
      { id, agent, instruction },
      editor.token,
    );
    await api(`/projects/${project}/run`, { id: t.id }, editor.token);
    const stream = await request(
      `/api/${agent}/events?operationId=${encodeURIComponent(t.operationId)}`,
      undefined,
      viewer.token,
    );
    assert.ok(stream.ok);
    const data = await stream.text();
    assert.match(data, /"type":"result"/, "SSE must finish normally");
    const result = await api(
      `/projects/${project}/refresh`,
      { id: t.id },
      viewer.token,
    );
    assert.equal(result.state, "done");
    return result;
  }
  await task(
    "build",
    builder.id,
    'Call team_note exactly once with id proof and content "shared-build-proof: SQLite schema is the chosen design." Confirm after success.',
  );
  const board = await api(
    `/projects/${project}/board`,
    undefined,
    viewer.token,
  );
  assert.ok(
    board.notes.some(
      (n: any) =>
        n.author === builder.id &&
        n.content === "shared-build-proof: SQLite schema is the chosen design.",
    ),
  );
  const review = await task(
    "review",
    reviewer.id,
    "Call team_board once. Identify the builder handoff marker and its database choice from actual shared evidence. Answer briefly.",
  );
  assert.match(review.result, /shared-build-proof/);
  assert.match(review.result, /SQLite/);
  const final = await api("/admin/billing/status");
  assert.equal(final.stopped, false);
  console.log(
    "PASS: hosted project-scoped editor/viewer access, two actual Pi agents, published handoff and grounded review; no execution or quota reset.",
    JSON.stringify({
      project,
      builder: builder.id,
      reviewer: reviewer.id,
      delta: {
        aiCalls: used(final, "aiCalls") - used(initial, "aiCalls"),
        neurons: used(final, "neurons") - used(initial, "neurons"),
        turns: used(final, "turns") - used(initial, "turns"),
        tools: used(final, "tools") - used(initial, "tools"),
      },
      totals: {
        aiCalls: used(final, "aiCalls"),
        neurons: used(final, "neurons"),
        executions: used(final, "executions"),
      },
    }),
  );
} catch (error) {
  await request("/admin/billing/stop", {});
  throw error;
}
