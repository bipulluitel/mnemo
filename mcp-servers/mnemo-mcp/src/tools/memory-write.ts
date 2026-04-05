import crypto from "node:crypto";
import { getDb } from "../db.js";
import { embedAndStore } from "../embed.js";
import type { ProfileFact, Episode, Entity } from "@mnemo/shared";

// ─── mnemo_remember ────────────────────────────

export function remember(
  category: string,
  key: string,
  value: string,
  confidence: number = 0.5,
  source: string = "inferred"
): ProfileFact {
  const db = getDb();

  const existing = db
    .prepare(`SELECT * FROM profile WHERE category = ? AND key = ?`)
    .get(category, key) as ProfileFact | undefined;

  if (existing) {
    db.prepare(
      `INSERT INTO profile_history (profile_id, old_value, new_value, reason)
       VALUES (?, ?, ?, ?)`
    ).run(existing.id, existing.value, value, `Updated via mnemo_remember`);

    db.prepare(
      `UPDATE profile SET value = ?, confidence = ?, source = ?,
       updated_at = datetime('now'), version = version + 1
       WHERE id = ?`
    ).run(value, confidence, source, existing.id);

    const updated = db
      .prepare(`SELECT * FROM profile WHERE id = ?`)
      .get(existing.id) as ProfileFact;
    embedAndStore("profile", existing.id, `${category} ${key}: ${value}`);

    // If this is the profile document, snapshot it
    if (category === "_system" && key === "profile_document") {
      snapshotProfileBuild(db, value);
    }

    return updated;
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO profile (id, category, key, value, confidence, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, category, key, value, confidence, source);

  const created = db.prepare(`SELECT * FROM profile WHERE id = ?`).get(id) as ProfileFact;
  embedAndStore("profile", id, `${category} ${key}: ${value}`);

  // If this is the profile document, snapshot it
  if (category === "_system" && key === "profile_document") {
    snapshotProfileBuild(db, value);
  }

  return created;
}

/** Snapshot current profile state into profile_builds */
function snapshotProfileBuild(db: ReturnType<typeof getDb>, document: string): void {
  const factCount = (
    db.prepare(`SELECT COUNT(*) as c FROM profile WHERE category != '_system'`).get() as { c: number }
  ).c;
  const episodeCount = (
    db.prepare(`SELECT COUNT(*) as c FROM episodes`).get() as { c: number }
  ).c;
  const entityCount = (
    db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as { c: number }
  ).c;
  const sessionCount = (
    db.prepare(`SELECT COUNT(*) as c FROM sessions`).get() as { c: number }
  ).c;

  // Get next version number
  const lastBuild = db
    .prepare(`SELECT MAX(version) as v FROM profile_builds`)
    .get() as { v: number | null };
  const version = (lastBuild?.v || 0) + 1;

  db.prepare(
    `INSERT INTO profile_builds (version, document, fact_count, episode_count, entity_count, session_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(version, document, factCount, episodeCount, entityCount, sessionCount);

  // Update meta
  db.prepare(
    `INSERT INTO mnemo_meta (key, value, updated_at)
     VALUES ('last_profile_build_at', datetime('now'), datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')`
  ).run();
  db.prepare(
    `INSERT INTO mnemo_meta (key, value, updated_at)
     VALUES ('profile_build_version', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(String(version));
}

// ─── mnemo_record_episode ──────────────────────

export function recordEpisode(
  summary: string,
  details?: string,
  tags?: string[],
  importance: number = 0.5,
  sessionId?: string
): Episode {
  const db = getDb();

  const tagsStr = tags ? JSON.stringify(tags) : null;

  const result = db
    .prepare(
      `INSERT INTO episodes (summary, details, tags, importance, session_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(summary, details || null, tagsStr, importance, sessionId || null);

  const episode = db
    .prepare(`SELECT * FROM episodes WHERE id = ?`)
    .get(result.lastInsertRowid) as Episode;
  const embedText = summary + (details ? ` ${details}` : "") + (tags ? ` ${tags.join(" ")}` : "");
  embedAndStore("episodes", episode.id, embedText);
  return episode;
}

// ─── mnemo_track_entity ────────────────────────

export function trackEntity(
  name: string,
  type: string,
  attributes?: Record<string, unknown>
): Entity {
  const db = getDb();

  const existing = db
    .prepare(`SELECT * FROM entities WHERE name = ? COLLATE NOCASE`)
    .get(name) as Entity | undefined;

  if (existing) {
    let merged = attributes || {};
    if (existing.attributes) {
      try {
        const old = JSON.parse(existing.attributes);
        merged = { ...old, ...merged };
      } catch {
        // ignore
      }
    }

    db.prepare(
      `UPDATE entities SET
         type = ?, attributes = ?, last_mentioned_at = datetime('now'),
         mention_count = mention_count + 1, updated_at = datetime('now')
       WHERE id = ?`
    ).run(type, JSON.stringify(merged), existing.id);

    const updated = db
      .prepare(`SELECT * FROM entities WHERE id = ?`)
      .get(existing.id) as Entity;
    const attrText = attributes ? ` ${JSON.stringify(attributes)}` : "";
    embedAndStore("entities", existing.id, `${type} ${name}${attrText}`);
    return updated;
  }

  const result = db
    .prepare(
      `INSERT INTO entities (name, type, attributes, last_mentioned_at)
       VALUES (?, ?, ?, datetime('now'))`
    )
    .run(name, type, attributes ? JSON.stringify(attributes) : null);

  const created = db
    .prepare(`SELECT * FROM entities WHERE id = ?`)
    .get(result.lastInsertRowid) as Entity;
  const attrText = attributes ? ` ${JSON.stringify(attributes)}` : "";
  embedAndStore("entities", created.id, `${type} ${name}${attrText}`);
  return created;
}

// ─── mnemo_relate ──────────────────────────────

export function relate(
  entityAName: string,
  entityBName: string,
  relation: string,
  context?: string
): { entity_a: Entity; entity_b: Entity; relation: string } {
  const db = getDb();

  let entityA = db
    .prepare(`SELECT * FROM entities WHERE name = ? COLLATE NOCASE`)
    .get(entityAName) as Entity | undefined;

  if (!entityA) {
    const r = db
      .prepare(
        `INSERT INTO entities (name, type, last_mentioned_at) VALUES (?, 'unknown', datetime('now'))`
      )
      .run(entityAName);
    entityA = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(r.lastInsertRowid) as Entity;
  }

  let entityB = db
    .prepare(`SELECT * FROM entities WHERE name = ? COLLATE NOCASE`)
    .get(entityBName) as Entity | undefined;

  if (!entityB) {
    const r = db
      .prepare(
        `INSERT INTO entities (name, type, last_mentioned_at) VALUES (?, 'unknown', datetime('now'))`
      )
      .run(entityBName);
    entityB = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(r.lastInsertRowid) as Entity;
  }

  const existing = db
    .prepare(
      `SELECT * FROM entity_relations
       WHERE entity_a = ? AND entity_b = ? AND relation = ?`
    )
    .get(entityA.id, entityB.id, relation);

  if (!existing) {
    db.prepare(
      `INSERT INTO entity_relations (entity_a, entity_b, relation, context)
       VALUES (?, ?, ?, ?)`
    ).run(entityA.id, entityB.id, relation, context || null);
  }

  return { entity_a: entityA, entity_b: entityB, relation };
}

// ─── mnemo_forget ──────────────────────────────

export function forget(
  query: string,
  confirm: boolean = false
): { matches: Array<{ table: string; id: number | string; content: string }>; deleted: boolean } {
  const db = getDb();
  const matches: Array<{ table: string; id: number | string; content: string }> = [];

  const profileHits = db
    .prepare(
      `SELECT p.id, p.key, p.value, p.category FROM profile_fts f
       JOIN profile p ON p.rowid = f.rowid
       WHERE profile_fts MATCH ? LIMIT 20`
    )
    .all(query) as Array<{ id: string; key: string; value: string; category: string }>;

  for (const h of profileHits) {
    matches.push({ table: "profile", id: h.id, content: `[${h.category}] ${h.key}: ${h.value}` });
  }

  const episodeHits = db
    .prepare(
      `SELECT e.id, e.summary FROM episodes_fts f
       JOIN episodes e ON e.id = f.rowid
       WHERE episodes_fts MATCH ? LIMIT 20`
    )
    .all(query) as Array<{ id: number; summary: string }>;

  for (const h of episodeHits) {
    matches.push({ table: "episodes", id: h.id, content: h.summary });
  }

  const entityHits = db
    .prepare(
      `SELECT e.id, e.name, e.type FROM entities_fts f
       JOIN entities e ON e.id = f.rowid
       WHERE entities_fts MATCH ? LIMIT 20`
    )
    .all(query) as Array<{ id: number; name: string; type: string }>;

  for (const h of entityHits) {
    matches.push({ table: "entities", id: h.id, content: `[${h.type}] ${h.name}` });
  }

  if (confirm && matches.length > 0) {
    const deleteProfile = db.prepare(`DELETE FROM profile WHERE id = ?`);
    const deleteEpisode = db.prepare(`DELETE FROM episodes WHERE id = ?`);
    const deleteEntity = db.prepare(`DELETE FROM entities WHERE id = ?`);
    const deleteRelations = db.prepare(
      `DELETE FROM entity_relations WHERE entity_a = ? OR entity_b = ?`
    );

    const tx = db.transaction(() => {
      for (const m of matches) {
        if (m.table === "profile") deleteProfile.run(m.id);
        if (m.table === "episodes") deleteEpisode.run(m.id);
        if (m.table === "entities") {
          deleteRelations.run(m.id, m.id);
          deleteEntity.run(m.id);
        }
      }
    });

    tx();
    return { matches, deleted: true };
  }

  return { matches, deleted: false };
}
