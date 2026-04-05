import { getDb } from "../db.js";
import type { Session } from "@mnemo/shared";

// ─── mnemo_save_session ────────────────────────

export function saveSession(
  sessionId: string,
  summary: string,
  keyDecisions?: string[],
  keyFacts?: string[],
  tags?: string[]
): Session {
  const db = getDb();

  const existing = db
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId) as Session | undefined;

  if (existing) {
    db.prepare(
      `UPDATE sessions SET
         ended_at = datetime('now'),
         summary = ?,
         key_decisions = ?,
         key_facts_learned = ?,
         topic_tags = ?
       WHERE id = ?`
    ).run(
      summary,
      keyDecisions ? JSON.stringify(keyDecisions) : null,
      keyFacts ? JSON.stringify(keyFacts) : null,
      tags ? JSON.stringify(tags) : null,
      sessionId
    );
  } else {
    db.prepare(
      `INSERT INTO sessions (id, started_at, ended_at, summary, key_decisions, key_facts_learned, topic_tags)
       VALUES (?, datetime('now'), datetime('now'), ?, ?, ?, ?)`
    ).run(
      sessionId,
      summary,
      keyDecisions ? JSON.stringify(keyDecisions) : null,
      keyFacts ? JSON.stringify(keyFacts) : null,
      tags ? JSON.stringify(tags) : null
    );
  }

  db.prepare(
    `UPDATE mnemo_meta SET
       value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
       updated_at = datetime('now')
     WHERE key = 'sessions_since_profile_build'`
  ).run();

  return db
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId) as Session;
}
