PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════════════════
-- PROFILE
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS profile (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,
    source TEXT DEFAULT 'inferred',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS profile_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    reason TEXT,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS profile_fts USING fts5(
    key, value, category,
    content=profile, content_rowid=rowid
);

-- FTS sync triggers for profile
CREATE TRIGGER IF NOT EXISTS profile_ai AFTER INSERT ON profile BEGIN
    INSERT INTO profile_fts(rowid, key, value, category)
    VALUES (new.rowid, new.key, new.value, new.category);
END;
CREATE TRIGGER IF NOT EXISTS profile_ad AFTER DELETE ON profile BEGIN
    INSERT INTO profile_fts(profile_fts, rowid, key, value, category)
    VALUES ('delete', old.rowid, old.key, old.value, old.category);
END;
CREATE TRIGGER IF NOT EXISTS profile_au AFTER UPDATE ON profile BEGIN
    INSERT INTO profile_fts(profile_fts, rowid, key, value, category)
    VALUES ('delete', old.rowid, old.key, old.value, old.category);
    INSERT INTO profile_fts(rowid, key, value, category)
    VALUES (new.rowid, new.key, new.value, new.category);
END;

-- ═══════════════════════════════════════════════
-- EPISODES
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL,
    details TEXT,
    tags TEXT,
    importance REAL DEFAULT 0.5,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
    summary, details, tags,
    content=episodes, content_rowid=id
);

-- FTS sync triggers for episodes
CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
    INSERT INTO episodes_fts(rowid, summary, details, tags)
    VALUES (new.id, new.summary, new.details, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
    INSERT INTO episodes_fts(episodes_fts, rowid, summary, details, tags)
    VALUES ('delete', old.id, old.summary, old.details, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
    INSERT INTO episodes_fts(episodes_fts, rowid, summary, details, tags)
    VALUES ('delete', old.id, old.summary, old.details, old.tags);
    INSERT INTO episodes_fts(rowid, summary, details, tags)
    VALUES (new.id, new.summary, new.details, new.tags);
END;

-- ═══════════════════════════════════════════════
-- ENTITIES
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    attributes TEXT,
    last_mentioned_at TEXT,
    mention_count INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entity_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_a INTEGER NOT NULL REFERENCES entities(id),
    entity_b INTEGER NOT NULL REFERENCES entities(id),
    relation TEXT NOT NULL,
    context TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    name, type, attributes,
    content=entities, content_rowid=id
);

-- FTS sync triggers for entities
CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, name, type, attributes)
    VALUES (new.id, new.name, new.type, new.attributes);
END;
CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, type, attributes)
    VALUES ('delete', old.id, old.name, old.type, old.attributes);
END;
CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, type, attributes)
    VALUES ('delete', old.id, old.name, old.type, old.attributes);
    INSERT INTO entities_fts(rowid, name, type, attributes)
    VALUES (new.id, new.name, new.type, new.attributes);
END;

-- ═══════════════════════════════════════════════
-- PROFILE BUILDS (versioned personality documents)
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS profile_builds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    document TEXT NOT NULL,
    fact_count INTEGER DEFAULT 0,
    episode_count INTEGER DEFAULT 0,
    entity_count INTEGER DEFAULT 0,
    session_count INTEGER DEFAULT 0,
    built_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_profile_builds_version ON profile_builds(version DESC);

-- ═══════════════════════════════════════════════
-- CONVERSATIONS
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT,
    ended_at TEXT,
    summary TEXT,
    key_decisions TEXT,
    key_facts_learned TEXT,
    topic_tags TEXT,
    message_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
    content, role,
    content=conversation_chunks, content_rowid=id
);

-- FTS sync triggers for conversation_chunks
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON conversation_chunks BEGIN
    INSERT INTO conversation_fts(rowid, content, role)
    VALUES (new.id, new.content, new.role);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON conversation_chunks BEGIN
    INSERT INTO conversation_fts(conversation_fts, rowid, content, role)
    VALUES ('delete', old.id, old.content, old.role);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON conversation_chunks BEGIN
    INSERT INTO conversation_fts(conversation_fts, rowid, content, role)
    VALUES ('delete', old.id, old.content, old.role);
    INSERT INTO conversation_fts(rowid, content, role)
    VALUES (new.id, new.content, new.role);
END;

-- ═══════════════════════════════════════════════
-- VECTOR EMBEDDINGS (sqlite-vec, added in v0.2)
-- ═══════════════════════════════════════════════

-- vec_memory table created programmatically when sqlite-vec is available

-- ═══════════════════════════════════════════════
-- SCHEDULED TASKS
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    schedule TEXT NOT NULL,
    timezone TEXT DEFAULT 'UTC',
    enabled INTEGER DEFAULT 1,
    requires_confirmation INTEGER DEFAULT 0,
    last_run_at TEXT,
    next_run_at TEXT,
    last_status TEXT,
    last_output TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES scheduled_tasks(id),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    output TEXT,
    error TEXT
);

-- ═══════════════════════════════════════════════
-- MESSAGES
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    channel TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
);

-- ═══════════════════════════════════════════════
-- SYSTEM STATE
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mnemo_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_profile_category ON profile(category);
CREATE INDEX IF NOT EXISTS idx_episodes_importance ON episodes(importance DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_entity_relations_a ON entity_relations(entity_a);
CREATE INDEX IF NOT EXISTS idx_entity_relations_b ON entity_relations(entity_b);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON conversation_chunks(session_id, chunk_index);
