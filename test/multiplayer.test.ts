import { expect, it } from "vitest";
import { ProjectStore } from "../src/multiplayer/store";
import { sqlite } from "./helpers";
import { HybridMemory } from "../src/core/memory";
import { prepareTurn } from "../src/pi/extension";
import { ExtractiveSummarizer } from "../src/summarization/extractive";
function fixture() {
  const db = sqlite();
  const teams = new ProjectStore(db.sql);
  teams.createProject("alpha", "Alpha");
  teams.createProject("beta", "Beta");
  const owner = teams.authorize("alpha", "", true);
  teams.member(owner, "editor", "Editor", "editor", "editor-hash");
  teams.member(owner, "viewer", "Viewer", "viewer", "viewer-hash");
  return { ...db, teams, owner };
}
it("isolates project credentials, revokes access and never exposes credential hashes in board reads", () => {
  const { teams, owner, db } = fixture();
  try {
    expect(teams.authorize("alpha", "editor-hash").role).toBe("editor");
    expect(() => teams.authorize("beta", "editor-hash")).toThrow(
      "access denied",
    );
    expect(JSON.stringify(teams.board("alpha"))).not.toContain("editor-hash");
    const viewer = teams.authorize("alpha", "viewer-hash");
    expect(() => teams.note(viewer, "n", "x")).toThrow("read only");
    expect(() => teams.member(viewer, "bad", "Bad", "editor", "bad")).toThrow(
      "Only owner",
    );
    teams.revoke(owner, "alpha:editor");
    expect(() => teams.authorize("alpha", "editor-hash")).toThrow(
      "access denied",
    );
  } finally {
    db.close();
  }
});
it("enforces bounded durable task ownership, stable dispatch identity and independent agent concurrency", () => {
  const { teams, owner, db } = fixture();
  try {
    const a = teams.addAgent(owner, "research", "Research"),
      b = teams.addAgent(owner, "review", "Review");
    const t = teams.task(owner, "one", a.id, "Research SQLite");
    expect(teams.task(owner, "one", a.id, "Research SQLite")).toEqual(t);
    expect(() => teams.task(owner, "one", a.id, "Different")).toThrow(
      "different input",
    );
    expect(() =>
      teams.task(teams.authorize("beta", "", true), "other", a.id, "x"),
    ).toThrow("not found");
    expect(teams.claim(owner, t.id)).toMatchObject({
      state: "running",
      claimed: true,
      dispatches: 1,
    });
    const second = teams.task(owner, "two", a.id, "x");
    expect(() => teams.claim(owner, second.id)).toThrow("running task");
    const independent = teams.task(owner, "three", b.id, "y");
    expect(teams.claim(owner, independent.id).claimed).toBe(true);
    expect(teams.claim(owner, t.id)).toMatchObject({
      operationId: t.operationId,
      dispatches: 2,
    });
    expect(() => teams.claim(owner, t.id)).toThrow("dispatch limit");
    teams.settle("alpha", t.id, "done", "Verified");
    expect(teams.claim(owner, t.id).claimed).toBe(false);
    expect(teams.claim(owner, second.id).claimed).toBe(true);
  } finally {
    db.close();
  }
});
it("keeps notes immutable and freezes shared context at the tail for retries without historical prefix mutation", async () => {
  const { teams, owner, sql, store, db } = fixture();
  try {
    const a = teams.addAgent(owner, "builder", "Build");
    teams.note(owner, "first", "Use SQLite");
    const memory = new HybridMemory({
      store,
      summarizer: new ExtractiveSummarizer(),
    });
    const before = await prepareTurn(
      memory,
      sql,
      "Build storage",
      "turn-one",
      {},
      teams.context(a.id)!.text,
    );
    teams.note(owner, "second", "Add migrations");
    expect(() => teams.note(owner, "first", "Overwrite")).toThrow(
      "different content",
    );
    const replay = await prepareTurn(
      memory,
      sql,
      "Build storage",
      "turn-one",
      {},
      teams.context(a.id)!.text,
    );
    expect(replay).toEqual(before);
    const next = await prepareTurn(
      memory,
      sql,
      "Review storage",
      "turn-two",
      {},
      teams.context(a.id)!.text,
    );
    expect(JSON.stringify(next.input)).toContain("Add migrations");
    expect(JSON.stringify(before.input)).not.toContain("Add migrations");
    expect(new ProjectStore(sql).context(a.id)).toEqual(teams.context(a.id));
  } finally {
    db.close();
  }
});
it("bounds project agents and metadata independent of client identities", () => {
  const { teams, owner, db } = fixture();
  try {
    for (let i = 0; i < 4; i++) teams.addAgent(owner, "a" + i, "Purpose");
    expect(() => teams.addAgent(owner, "extra", "Purpose")).toThrow("limit");
    for (let i = 0; i < 100; i++) teams.note(owner, "n" + i, "Note");
    expect(() => teams.note(owner, "overflow", "Note")).toThrow("limit");
    expect(teams.board("alpha").notes).toHaveLength(20);
  } finally {
    db.close();
  }
});

it("ships parseable project UI code and keeps credential display explicit", async () => {
  const { multiplayerUI } = await import("../src/multiplayer/ui");
  expect(
    () => new Function(multiplayerUI.match(/<script>([\s\S]*)<\/script>/)![1]),
  ).not.toThrow();
  expect(multiplayerUI).not.toContain("localStorage");
});

it("preserves submitting member provenance and rejects cross-member operation replay", async () => {
  const { sql, store, db } = sqlite();
  try {
    const memory = new HybridMemory({
      store,
      summarizer: new ExtractiveSummarizer(),
    });
    const first = await prepareTurn(
      memory,
      sql,
      "My database preference",
      "actor-turn",
      {},
      "shared project",
      "alpha:alice",
    );
    expect(JSON.stringify(first.input)).toContain("alpha:alice");
    expect(
      await prepareTurn(
        memory,
        sql,
        "My database preference",
        "actor-turn",
        {},
        "changed shared project",
        "alpha:alice",
      ),
    ).toEqual(first);
    await expect(
      prepareTurn(
        memory,
        sql,
        "My database preference",
        "actor-turn",
        {},
        "shared project",
        "alpha:bob",
      ),
    ).rejects.toThrow("different project member");
  } finally {
    db.close();
  }
});

it("validates signed project credentials offline and rejects forgery, expiration and owner-key rotation", async () => {
  const { issueCredential, verifyCredential } =
    await import("../src/multiplayer/credentials");
  const now = Date.now();
  const token = await issueCredential("alpha", "fixture-owner-secret", now);
  expect(await verifyCredential(token, "fixture-owner-secret", now)).toBe(true);
  expect(await verifyCredential(token, "changed-owner-secret", now)).toBe(
    false,
  );
  const parts = token.split(".");
  expect(
    await verifyCredential(
      parts[0] + "." + parts[1].slice(0, -1) + "a." + parts[2],
      "fixture-owner-secret",
      now,
    ),
  ).toBe(false);
  expect(
    await verifyCredential(token, "fixture-owner-secret", now + 31 * 86400000),
  ).toBe(false);
  expect(
    await verifyCredential("random token", "fixture-owner-secret", now),
  ).toBe(false);
});
it("rotates credentials for an existing member without consuming additional member slots or changing identity", () => {
  const { teams, owner, db } = fixture();
  try {
    teams.member(owner, "editor", "Editor", "editor", "replacement-hash");
    expect(() => teams.authorize("alpha", "editor-hash")).toThrow(
      "access denied",
    );
    expect(teams.authorize("alpha", "replacement-hash").member).toBe(
      "alpha:editor",
    );
    expect(teams.board("alpha").members).toHaveLength(2);
  } finally {
    db.close();
  }
});
