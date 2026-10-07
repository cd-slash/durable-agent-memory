import type { SqlDriver } from "../storage/durable-sqlite";
export type Role = "editor" | "viewer";
export class ProjectError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Actor {
  owner: boolean;
  project: string;
  member: string;
  role: Role;
}
export const PROJECT_TOOLS = [
  "remember",
  "recall",
  "memory_expand",
  "read",
  "write",
  "edit",
  "delete",
  "ls",
  "find",
  "grep",
  "exec",
  "web_fetch",
  "team_board",
  "team_note",
];
export interface ProjectAgent {
  id: string;
  project: string;
  label: string;
  purpose: string;
  allowedTools: string[];
}
export interface TeamTask {
  id: string;
  project: string;
  agent: string;
  instruction: string;
  createdBy: string;
  state: "pending" | "running" | "done" | "failed" | "cancelled";
  operationId: string;
  result: string;
  dispatches: number;
  createdAt: number;
}
const name = (v: unknown) => {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(v))
    throw new ProjectError(400, "Invalid project identifier");
  return v;
};
const text = (v: unknown, max: number) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new ProjectError(400, "Invalid project text");
  return v;
};
export class ProjectStore {
  constructor(private sql: SqlDriver) {
    sql.run(
      "CREATE TABLE IF NOT EXISTS mp_projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt INTEGER NOT NULL)",
    );
    sql.run(
      "CREATE TABLE IF NOT EXISTS mp_members(id TEXT PRIMARY KEY,project TEXT NOT NULL,label TEXT NOT NULL,role TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)",
    );
    sql.run(
      "CREATE TABLE IF NOT EXISTS mp_agents(id TEXT PRIMARY KEY,project TEXT NOT NULL,label TEXT NOT NULL,purpose TEXT NOT NULL,allowedTools TEXT NOT NULL,UNIQUE(project,label))",
    );
    sql.run(
      "CREATE TABLE IF NOT EXISTS mp_tasks(id TEXT PRIMARY KEY,project TEXT NOT NULL,agent TEXT NOT NULL,instruction TEXT NOT NULL,createdBy TEXT NOT NULL,state TEXT NOT NULL,operationId TEXT UNIQUE NOT NULL,result TEXT NOT NULL,dispatches INTEGER NOT NULL,createdAt INTEGER NOT NULL)",
    );
    sql.run(
      "CREATE TABLE IF NOT EXISTS mp_notes(id TEXT PRIMARY KEY,project TEXT NOT NULL,author TEXT NOT NULL,content TEXT NOT NULL,createdAt INTEGER NOT NULL)",
    );
  }
  projects() {
    return this.sql.all(
      "SELECT * FROM mp_projects ORDER BY createdAt LIMIT 10",
    );
  }
  exists(project: string) {
    return !!this.sql.all("SELECT id FROM mp_projects WHERE id=?", project)
      .length;
  }
  createProject(id: string, title: string) {
    name(id);
    text(title, 120);
    return this.sql.transaction(() => {
      if (this.exists(id))
        throw new ProjectError(409, "Project already exists");
      if (this.projects().length >= 10)
        throw new ProjectError(409, "Project count limit reached");
      this.sql.run(
        "INSERT INTO mp_projects VALUES(?,?,?)",
        id,
        title,
        Date.now(),
      );
      return { id, title };
    });
  }
  authorize(project: string, hash: string, owner = false): Actor {
    name(project);
    if (!this.exists(project)) throw new ProjectError(404, "Project not found");
    if (owner) return { owner: true, project, member: "owner", role: "editor" };
    const row = this.sql.all<{ id: string; role: Role }>(
      "SELECT id,role FROM mp_members WHERE project=? AND hash=? AND revoked=0",
      project,
      hash,
    )[0];
    if (!row) throw new ProjectError(403, "Project access denied");
    return { owner: false, project, member: row.id, role: row.role };
  }
  writable(actor: Actor) {
    if (actor.role !== "editor")
      throw new ProjectError(403, "Project is read only");
  }
  member(actor: Actor, id: string, label: string, role: Role, hash: string) {
    if (!actor.owner)
      throw new ProjectError(403, "Only owner may manage credentials");
    name(id);
    text(label, 80);
    if (!["viewer", "editor"].includes(role))
      throw new ProjectError(400, "Invalid project role");
    return this.sql.transaction(() => {
      if (
        this.sql.all("SELECT id FROM mp_members WHERE project=?", actor.project)
          .length >= 8
      )
        throw new ProjectError(409, "Member count limit reached");
      this.sql.run(
        "INSERT INTO mp_members(id,project,label,role,hash) VALUES(?,?,?,?,?)",
        `${actor.project}:${id}`,
        actor.project,
        label,
        role,
        hash,
      );
      return { id: `${actor.project}:${id}`, label, role };
    });
  }
  revoke(actor: Actor, id: string) {
    if (!actor.owner)
      throw new ProjectError(403, "Only owner may manage credentials");
    this.sql.run(
      "UPDATE mp_members SET revoked=1 WHERE project=? AND id=?",
      actor.project,
      id,
    );
    return { revoked: true };
  }
  addAgent(
    actor: Actor,
    label: string,
    purpose: string,
    allowedTools: string[] = PROJECT_TOOLS,
  ): ProjectAgent {
    if (!actor.owner) throw new ProjectError(403, "Only owner may add agents");
    name(label);
    text(purpose, 1000);
    if (
      !Array.isArray(allowedTools) ||
      allowedTools.length > PROJECT_TOOLS.length ||
      allowedTools.some((tool) => !PROJECT_TOOLS.includes(tool))
    )
      throw new ProjectError(400, "Invalid project tool policy");
    return this.sql.transaction(() => {
      if (
        this.sql.all("SELECT id FROM mp_agents WHERE project=?", actor.project)
          .length >= 4
      )
        throw new ProjectError(409, "Project agent limit reached");
      if (
        this.sql.all(
          "SELECT id FROM mp_agents WHERE project=? AND label=?",
          actor.project,
          label,
        ).length
      )
        throw new ProjectError(409, "Agent label already exists");
      const id = `mp-${crypto.randomUUID()}`;
      this.sql.run(
        "INSERT INTO mp_agents VALUES(?,?,?,?,?)",
        id,
        actor.project,
        label,
        purpose,
        JSON.stringify(allowedTools),
      );
      return { id, project: actor.project, label, purpose, allowedTools };
    });
  }
  agent(id: string): ProjectAgent | undefined {
    const row = this.sql.all<
      Omit<ProjectAgent, "allowedTools"> & { allowedTools: string }
    >("SELECT * FROM mp_agents WHERE id=?", id)[0];
    return row
      ? { ...row, allowedTools: JSON.parse(row.allowedTools) }
      : undefined;
  }
  requireAgent(project: string, id: string) {
    const agent = this.agent(id);
    if (!agent || agent.project !== project)
      throw new ProjectError(404, "Project agent not found");
    return agent;
  }
  board(project: string) {
    if (!this.exists(project)) throw new ProjectError(404, "Project not found");
    return {
      project: this.sql.all("SELECT * FROM mp_projects WHERE id=?", project)[0],
      agents: this.sql
        .all<{ id: string }>(
          "SELECT id FROM mp_agents WHERE project=? ORDER BY label",
          project,
        )
        .map((row) => this.agent(row.id)!),
      members: this.sql.all(
        "SELECT id,label,role,revoked FROM mp_members WHERE project=?",
        project,
      ),
      tasks: this.sql.all<TeamTask>(
        "SELECT * FROM mp_tasks WHERE project=? ORDER BY createdAt DESC LIMIT 20",
        project,
      ),
      notes: this.sql.all(
        "SELECT * FROM mp_notes WHERE project=? ORDER BY createdAt DESC LIMIT 20",
        project,
      ),
    };
  }
  task(actor: Actor, id: string, agent: string, instruction: string): TeamTask {
    this.writable(actor);
    name(id);
    text(instruction, 4000);
    this.requireAgent(actor.project, agent);
    return this.sql.transaction(() => {
      const taskId = `${actor.project}:${id}`,
        existing = this.getTask(actor.project, taskId);
      if (existing) {
        if (existing.agent !== agent || existing.instruction !== instruction)
          throw new ProjectError(409, "Task id reused with different input");
        return existing;
      }
      if (
        this.sql.all("SELECT id FROM mp_tasks WHERE project=?", actor.project)
          .length >= 100
      )
        throw new ProjectError(409, "Task count limit reached");
      const result: TeamTask = {
        id: taskId,
        project: actor.project,
        agent,
        instruction,
        createdBy: actor.member,
        state: "pending",
        operationId: `team-${crypto.randomUUID()}`,
        result: "",
        dispatches: 0,
        createdAt: Date.now(),
      };
      this.sql.run(
        "INSERT INTO mp_tasks VALUES(?,?,?,?,?,?,?,?,?,?)",
        result.id,
        result.project,
        result.agent,
        result.instruction,
        result.createdBy,
        result.state,
        result.operationId,
        result.result,
        result.dispatches,
        result.createdAt,
      );
      return result;
    });
  }
  getTask(project: string, id: string) {
    return this.sql.all<TeamTask>(
      "SELECT * FROM mp_tasks WHERE project=? AND id=?",
      project,
      id,
    )[0];
  }
  claim(actor: Actor, id: string) {
    this.writable(actor);
    return this.sql.transaction(() => {
      const task = this.getTask(actor.project, id);
      if (!task) throw new ProjectError(404, "Task not found");
      if (!["pending", "running"].includes(task.state))
        return { ...task, claimed: false };
      if (task.dispatches >= 2)
        throw new ProjectError(
          409,
          "Task dispatch limit reached; inspect existing operation",
        );
      if (task.state === "running") {
        this.sql.run(
          "UPDATE mp_tasks SET dispatches=dispatches+1 WHERE id=?",
          id,
        );
        return { ...task, dispatches: task.dispatches + 1, claimed: true };
      }
      if (
        this.sql.all(
          "SELECT id FROM mp_tasks WHERE agent=? AND state=?",
          task.agent,
          "running",
        ).length
      )
        throw new ProjectError(409, "Agent already owns a running task");
      this.sql.run(
        "UPDATE mp_tasks SET state=?,dispatches=dispatches+1 WHERE id=?",
        "running",
        id,
      );
      return {
        ...task,
        state: "running" as const,
        dispatches: task.dispatches + 1,
        claimed: true,
      };
    });
  }
  settle(
    project: string,
    id: string,
    state: "done" | "failed" | "cancelled",
    result: string,
  ) {
    const task = this.getTask(project, id);
    if (!task) throw new ProjectError(404, "Task not found");
    if (
      task.state !== "running" &&
      !(task.state === "pending" && state === "cancelled")
    )
      return task;
    this.sql.run(
      "UPDATE mp_tasks SET state=?,result=? WHERE id=?",
      state,
      result.slice(0, 6000),
      id,
    );
    return this.getTask(project, id)!;
  }
  note(actor: Actor, id: string, content: string) {
    this.writable(actor);
    name(id);
    text(content, 2000);
    return this.sql.transaction(() => {
      const key = `${actor.project}:${id}`,
        old = this.sql.all<{ content: string }>(
          "SELECT content FROM mp_notes WHERE id=?",
          key,
        )[0];
      if (old) {
        if (old.content !== content)
          throw new ProjectError(409, "Note id reused with different content");
        return { id: key };
      }
      if (
        this.sql.all("SELECT id FROM mp_notes WHERE project=?", actor.project)
          .length >= 100
      )
        throw new ProjectError(409, "Note count limit reached");
      this.sql.run(
        "INSERT INTO mp_notes VALUES(?,?,?,?,?)",
        key,
        actor.project,
        actor.member,
        content,
        Date.now(),
      );
      return { id: key };
    });
  }
  context(agentId: string) {
    const agent = this.agent(agentId);
    if (!agent) return undefined;
    const notes = this.sql.all<{ author: string; content: string }>(
      "SELECT author,content FROM mp_notes WHERE project=? ORDER BY createdAt DESC LIMIT 8",
      agent.project,
    );
    const tasks = this.sql.all<{
      agent: string;
      state: string;
      result: string;
    }>(
      "SELECT agent,state,result FROM mp_tasks WHERE project=? ORDER BY createdAt DESC LIMIT 4",
      agent.project,
    );
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        project: agent.project,
        agent: agent.label,
        purpose: agent.purpose,
        allowedTools: agent.allowedTools,
        notes,
        tasks,
      }),
    );
    return { agent, text: new TextDecoder().decode(encoded.slice(0, 6000)) };
  }
}
