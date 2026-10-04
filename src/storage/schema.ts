export const schema = `
CREATE TABLE IF NOT EXISTS hm_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE, position INTEGER NOT NULL, namespace TEXT NOT NULL,
 created_at INTEGER NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
 metadata_json TEXT NOT NULL, content_hash TEXT NOT NULL,
 UNIQUE(namespace, position)
);
CREATE TABLE IF NOT EXISTS hm_nodes (
 id TEXT PRIMARY KEY, namespace TEXT NOT NULL, range_start INTEGER NOT NULL,
 range_end INTEGER NOT NULL, level INTEGER NOT NULL, version TEXT NOT NULL,
 created_at INTEGER NOT NULL, content_hash TEXT NOT NULL, record_json TEXT NOT NULL,
 UNIQUE(namespace, range_start, range_end, version)
);
CREATE TABLE IF NOT EXISTS hm_embeddings (
 id TEXT NOT NULL, model TEXT NOT NULL, version TEXT NOT NULL, vector_json TEXT NOT NULL,
 PRIMARY KEY(id, model, version)
);
CREATE TABLE IF NOT EXISTS hm_submissions (
 id TEXT PRIMARY KEY, query TEXT NOT NULL, input_json TEXT NOT NULL, context_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hm_epochs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, handoff TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS hm_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS hm_events_no_update BEFORE UPDATE ON hm_events
 BEGIN SELECT RAISE(ABORT, 'Memory events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS hm_events_no_delete BEFORE DELETE ON hm_events
 BEGIN SELECT RAISE(ABORT, 'Memory events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS hm_nodes_no_update BEFORE UPDATE ON hm_nodes
 BEGIN SELECT RAISE(ABORT, 'Summary nodes are immutable'); END;
CREATE TRIGGER IF NOT EXISTS hm_nodes_no_delete BEFORE DELETE ON hm_nodes
 BEGIN SELECT RAISE(ABORT, 'Summary nodes are immutable'); END;
CREATE TRIGGER IF NOT EXISTS hm_submissions_no_update BEFORE UPDATE ON hm_submissions
 BEGIN SELECT RAISE(ABORT, 'Frozen submissions are immutable'); END;
`;
