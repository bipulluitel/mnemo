import { getDb } from "../db.js";
import { embedQuery } from "../embed.js";
import { queryVec, isVecAvailable } from "@mnemo/shared";
import type {
  ProfileFact,
  ProfileBuild,
  Episode,
  Session,
  Entity,
  EntityRelation,
  RecallResult,
} from "@mnemo/shared";

// ─── mnemo_recall ──────────────────────────────
// Hybrid search: FTS5 (keyword match) + sqlite-vec (semantic similarity)
// Scoring: fts_score * 0.4 + vec_score * 0.4 + importance * 0.2

export async function recall(query: string, limit: number = 10): Promise<RecallResult[]> {
  const db = getDb();

  // Run FTS and vector search in parallel
  const ftsResults = ftsSearch(db, query, limit * 2);
  const vecResults = await vecSearch(db, query, limit * 2);

  // Build a combined map keyed by "table:id"
  const combined = new Map<string, RecallResult & { ftsScore: number; vecScore: number }>();

  // Normalize FTS scores: convert to 0..1 range
  const maxFts = ftsResults.reduce((m, r) => Math.max(m, r.score), 0) || 1;
  for (const r of ftsResults) {
    const key = `${r.source_table}:${r.source_id}`;
    combined.set(key, {
      ...r,
      ftsScore: r.score / maxFts,
      vecScore: 0,
    });
  }

  // Merge vector results
  for (const v of vecResults) {
    const key = `${v.source_table}:${v.source_id}`;
    const existing = combined.get(key);
    if (existing) {
      existing.vecScore = v.score;
    } else {
      combined.set(key, { ...v, ftsScore: 0, vecScore: v.score });
    }
  }

  // Compute final score
  const results: RecallResult[] = [];
  for (const entry of combined.values()) {
    const importance = (entry.metadata?.importance as number) || 0;
    entry.score = entry.ftsScore * 0.4 + entry.vecScore * 0.4 + importance * 0.2;
    results.push(entry);
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** FTS search across all tables */
function ftsSearch(db: Database, query: string, limit: number): RecallResult[] {
  const results: RecallResult[] = [];

  const profileHits = db
    .prepare(
      `SELECT p.rowid as rowid, p.id, p.category, p.key, p.value, p.confidence,
              rank
       FROM profile_fts f
       JOIN profile p ON p.rowid = f.rowid
       WHERE profile_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query, limit) as Array<{
    rowid: number;
    id: string;
    category: string;
    key: string;
    value: string;
    confidence: number;
    rank: number;
  }>;

  for (const hit of profileHits) {
    results.push({
      source_table: "profile",
      source_id: hit.rowid,
      content: `[${hit.category}] ${hit.key}: ${hit.value}`,
      score: -hit.rank,
      created_at: "",
      metadata: { category: hit.category, confidence: hit.confidence },
    });
  }

  const episodeHits = db
    .prepare(
      `SELECT e.id, e.summary, e.details, e.tags, e.importance, e.created_at,
              rank
       FROM episodes_fts f
       JOIN episodes e ON e.id = f.rowid
       WHERE episodes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query, limit) as Array<{
    id: number;
    summary: string;
    details: string | null;
    tags: string | null;
    importance: number;
    created_at: string;
    rank: number;
  }>;

  for (const hit of episodeHits) {
    results.push({
      source_table: "episodes",
      source_id: hit.id,
      content: hit.summary + (hit.details ? ` — ${hit.details}` : ""),
      score: -hit.rank,
      created_at: hit.created_at,
      metadata: { tags: hit.tags, importance: hit.importance },
    });
  }

  const convHits = db
    .prepare(
      `SELECT c.id, c.session_id, c.role, c.content, c.created_at, rank
       FROM conversation_fts f
       JOIN conversation_chunks c ON c.id = f.rowid
       WHERE conversation_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query, limit) as Array<{
    id: number;
    session_id: string;
    role: string;
    content: string;
    created_at: string;
    rank: number;
  }>;

  for (const hit of convHits) {
    results.push({
      source_table: "conversations",
      source_id: hit.id,
      content: `[${hit.role}] ${hit.content}`,
      score: -hit.rank,
      created_at: hit.created_at,
      metadata: { session_id: hit.session_id, role: hit.role },
    });
  }

  const entityHits = db
    .prepare(
      `SELECT e.id, e.name, e.type, e.attributes, e.mention_count, e.created_at, rank
       FROM entities_fts f
       JOIN entities e ON e.id = f.rowid
       WHERE entities_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query, limit) as Array<{
    id: number;
    name: string;
    type: string;
    attributes: string | null;
    mention_count: number;
    created_at: string;
    rank: number;
  }>;

  for (const hit of entityHits) {
    results.push({
      source_table: "entities",
      source_id: hit.id,
      content: `[${hit.type}] ${hit.name}${hit.attributes ? ` — ${hit.attributes}` : ""}`,
      score: -hit.rank,
      created_at: hit.created_at,
      metadata: { type: hit.type, mention_count: hit.mention_count },
    });
  }

  return results;
}

/** Vector similarity search across all embedded content */
async function vecSearch(db: Database, query: string, limit: number): Promise<RecallResult[]> {
  if (!isVecAvailable()) return [];

  const queryEmbed = await embedQuery(query);
  if (!queryEmbed) return [];

  const vecHits = queryVec(db, queryEmbed, undefined, limit);
  const results: RecallResult[] = [];

  for (const hit of vecHits) {
    // Distance is cosine distance: 0 = identical, 2 = opposite
    // Convert to score: 1.0 (identical) to 0.0 (irrelevant)
    const score = Math.max(0, 1.0 - hit.distance);

    // Look up the actual content from the source table
    const content = lookupContent(db, hit.source_table, hit.source_id);
    if (!content) continue;

    results.push({
      source_table: hit.source_table,
      source_id: parseInt(hit.source_id, 10) || 0,
      content: content.text,
      score,
      created_at: content.created_at,
      metadata: content.metadata,
    });
  }

  return results;
}

/** Look up display content from a source table row */
function lookupContent(
  db: Database,
  table: string,
  id: string
): { text: string; created_at: string; metadata?: Record<string, unknown> } | null {
  switch (table) {
    case "profile": {
      const row = db
        .prepare(`SELECT * FROM profile WHERE id = ? OR rowid = ?`)
        .get(id, id) as { category: string; key: string; value: string; confidence: number } | undefined;
      if (!row) return null;
      return {
        text: `[${row.category}] ${row.key}: ${row.value}`,
        created_at: "",
        metadata: { category: row.category, confidence: row.confidence },
      };
    }
    case "episodes": {
      const row = db
        .prepare(`SELECT * FROM episodes WHERE id = ?`)
        .get(id) as Episode | undefined;
      if (!row) return null;
      return {
        text: row.summary + (row.details ? ` — ${row.details}` : ""),
        created_at: row.created_at,
        metadata: { tags: row.tags, importance: row.importance },
      };
    }
    case "conversation_chunks": {
      const row = db
        .prepare(`SELECT * FROM conversation_chunks WHERE id = ?`)
        .get(id) as { role: string; content: string; session_id: string; created_at: string } | undefined;
      if (!row) return null;
      return {
        text: `[${row.role}] ${row.content}`,
        created_at: row.created_at,
        metadata: { session_id: row.session_id, role: row.role },
      };
    }
    case "entities": {
      const row = db
        .prepare(`SELECT * FROM entities WHERE id = ?`)
        .get(id) as Entity | undefined;
      if (!row) return null;
      return {
        text: `[${row.type}] ${row.name}${row.attributes ? ` — ${row.attributes}` : ""}`,
        created_at: row.created_at,
        metadata: { type: row.type, mention_count: row.mention_count },
      };
    }
    default:
      return null;
  }
}

type Database = import("better-sqlite3").Database;

// ─── mnemo_profile ─────────────────────────────

export function getProfile(category?: string): ProfileFact[] | string {
  const db = getDb();

  if (!category) {
    // Return the synthesized profile document if available
    const doc = db
      .prepare(
        `SELECT value FROM mnemo_meta WHERE key = 'profile_document'`
      )
      .get() as { value: string } | undefined;

    if (doc) return doc.value;

    // Fall back to all facts
    return db
      .prepare(`SELECT * FROM profile ORDER BY category, key`)
      .all() as ProfileFact[];
  }

  return db
    .prepare(`SELECT * FROM profile WHERE category = ? ORDER BY key`)
    .all(category) as ProfileFact[];
}

// ─── mnemo_episodes ────────────────────────────

export function getEpisodes(
  limit: number = 10,
  since?: string,
  tags?: string[]
): Episode[] {
  const db = getDb();

  let sql = `SELECT * FROM episodes`;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (since) {
    conditions.push(`created_at >= ?`);
    params.push(since);
  }

  if (tags && tags.length > 0) {
    const tagConditions = tags.map(() => `tags LIKE ?`);
    conditions.push(`(${tagConditions.join(" OR ")})`);
    for (const tag of tags) {
      params.push(`%${tag}%`);
    }
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as Episode[];
}

// ─── mnemo_sessions ────────────────────────────

export function getSessions(limit: number = 5, since?: string): Session[] {
  const db = getDb();

  if (since) {
    return db
      .prepare(
        `SELECT * FROM sessions WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?`
      )
      .all(since, limit) as Session[];
  }

  return db
    .prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as Session[];
}

// ─── mnemo_entity ──────────────────────────────

export function getEntity(
  name: string
): { entity: Entity; relations: Array<EntityRelation & { other_name: string }> } | null {
  const db = getDb();

  const entity = db
    .prepare(
      `SELECT * FROM entities WHERE name = ? COLLATE NOCASE LIMIT 1`
    )
    .get(name) as Entity | undefined;

  if (!entity) {
    const fuzzy = db
      .prepare(
        `SELECT * FROM entities WHERE name LIKE ? COLLATE NOCASE LIMIT 1`
      )
      .get(`%${name}%`) as Entity | undefined;

    if (!fuzzy) return null;
    return getEntityById(fuzzy);
  }

  return getEntityById(entity);
}

function getEntityById(
  entity: Entity
): { entity: Entity; relations: Array<EntityRelation & { other_name: string }> } {
  const db = getDb();

  const relations = db
    .prepare(
      `SELECT r.*,
              CASE WHEN r.entity_a = ? THEN eb.name ELSE ea.name END as other_name
       FROM entity_relations r
       JOIN entities ea ON ea.id = r.entity_a
       JOIN entities eb ON eb.id = r.entity_b
       WHERE r.entity_a = ? OR r.entity_b = ?`
    )
    .all(entity.id, entity.id, entity.id) as Array<
    EntityRelation & { other_name: string }
  >;

  return { entity, relations };
}

// ─── mnemo_search_entities ─────────────────────

export function searchEntities(
  query: string,
  type?: string,
  limit: number = 10
): Entity[] {
  const db = getDb();

  if (query === "*") {
    if (type) {
      return db
        .prepare(`SELECT * FROM entities WHERE type = ? ORDER BY mention_count DESC LIMIT ?`)
        .all(type, limit) as Entity[];
    }
    return db
      .prepare(`SELECT * FROM entities ORDER BY mention_count DESC LIMIT ?`)
      .all(limit) as Entity[];
  }

  let sql = `SELECT e.* FROM entities_fts f JOIN entities e ON e.id = f.rowid WHERE entities_fts MATCH ?`;
  const params: unknown[] = [query];

  if (type) {
    sql += ` AND e.type = ?`;
    params.push(type);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as Entity[];
}

// ─── mnemo_profile_history ─────────────────────

export function getProfileHistory(limit: number = 5): ProfileBuild[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM profile_builds ORDER BY version DESC LIMIT ?`)
    .all(limit) as ProfileBuild[];
}

export function getProfileBuild(version: number): ProfileBuild | null {
  const db = getDb();
  return (
    (db
      .prepare(`SELECT * FROM profile_builds WHERE version = ?`)
      .get(version) as ProfileBuild | undefined) || null
  );
}
