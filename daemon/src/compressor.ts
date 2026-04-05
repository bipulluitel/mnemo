/**
 * Compressor — Progressive memory aging.
 *
 * Runs daily at 3am. Reduces storage by progressively compressing old data:
 *
 * | Age          | Kept                                  | Removed                        |
 * |-------------|---------------------------------------|--------------------------------|
 * | < 7 days    | Full chunks + embeddings              | —                              |
 * | 7–30 days   | Session summary + episodes + embeddings| Raw conversation chunks        |
 * | > 30 days   | Profile facts + episodes only         | Summaries compressed to 1 line |
 */

import Database from "better-sqlite3";
import { Logger } from "@mnemo/shared";

export class Compressor {
  private db: Database.Database;
  private logger: Logger;
  private keepFullDays: number;
  private keepSummaryDays: number;
  private lastRun: number = 0;

  constructor(
    db: Database.Database,
    logger: Logger,
    keepFullDays: number = 7,
    keepSummaryDays: number = 30
  ) {
    this.db = db;
    this.logger = logger;
    this.keepFullDays = keepFullDays;
    this.keepSummaryDays = keepSummaryDays;
  }

  /** Called every tick. Only runs once per day at ~3am. */
  tick(): void {
    const now = new Date();
    const hour = now.getHours();

    // Only run at 3am
    if (hour !== 3) return;

    // Only run once per day
    const today = now.toISOString().split("T")[0];
    const lastRunDay = this.lastRun
      ? new Date(this.lastRun).toISOString().split("T")[0]
      : "";

    if (today === lastRunDay) return;

    this.lastRun = now.getTime();
    this.logger.info("Compressor running");

    try {
      const stats = this.compress();
      this.logger.info("Compressor complete", stats);

      // Record in meta
      this.db
        .prepare(
          `INSERT INTO mnemo_meta (key, value, updated_at)
           VALUES ('last_compression_at', datetime('now'), datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')`
        )
        .run();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Compressor failed: ${msg}`);
    }
  }

  /** Run compression manually (e.g., from a command) */
  compressNow(): CompressionStats {
    this.lastRun = Date.now();
    return this.compress();
  }

  private compress(): CompressionStats {
    const stats: CompressionStats = {
      chunksDeleted: 0,
      embeddingsDeleted: 0,
      summariesCompressed: 0,
      episodesCompressed: 0,
    };

    // ── Phase 1: Delete raw chunks older than keepFullDays ──
    const fullCutoff = this.daysAgo(this.keepFullDays);

    // Get session IDs that have chunks older than the cutoff
    // but only if the session has a summary (don't delete if unsummarized)
    const sessionsToTrim = this.db
      .prepare(
        `SELECT s.id FROM sessions s
         WHERE s.started_at < ?
         AND s.summary IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM conversation_chunks c WHERE c.session_id = s.id
         )`
      )
      .all(fullCutoff) as Array<{ id: string }>;

    if (sessionsToTrim.length > 0) {
      const deleteChunks = this.db.prepare(
        `DELETE FROM conversation_chunks WHERE session_id = ?`
      );
      const deleteChunkEmbeddings = this.db.prepare(
        `DELETE FROM vec_memory
         WHERE source_table = 'conversation_chunks'
         AND source_id IN (
           SELECT CAST(id AS TEXT) FROM conversation_chunks WHERE session_id = ?
         )`
      );

      const tx = this.db.transaction(() => {
        for (const session of sessionsToTrim) {
          // Delete embeddings for these chunks first (if vec table exists)
          try {
            deleteChunkEmbeddings.run(session.id);
          } catch {
            // vec_memory might not exist
          }

          const result = deleteChunks.run(session.id);
          stats.chunksDeleted += result.changes;
        }
      });

      tx();

      if (stats.chunksDeleted > 0) {
        this.logger.info(
          `Deleted ${stats.chunksDeleted} chunks from ${sessionsToTrim.length} sessions older than ${this.keepFullDays} days`
        );
      }
    }

    // ── Phase 2: Compress old session summaries (> keepSummaryDays) ──
    const summaryCutoff = this.daysAgo(this.keepSummaryDays);

    const oldSessions = this.db
      .prepare(
        `SELECT id, summary FROM sessions
         WHERE started_at < ?
         AND summary IS NOT NULL
         AND length(summary) > 200`
      )
      .all(summaryCutoff) as Array<{ id: string; summary: string }>;

    if (oldSessions.length > 0) {
      const updateSummary = this.db.prepare(
        `UPDATE sessions SET summary = ? WHERE id = ?`
      );

      const tx = this.db.transaction(() => {
        for (const session of oldSessions) {
          // Compress to first sentence or first 150 chars
          const compressed = compressSummary(session.summary);
          updateSummary.run(compressed, session.id);
          stats.summariesCompressed++;
        }
      });

      tx();

      if (stats.summariesCompressed > 0) {
        this.logger.info(
          `Compressed ${stats.summariesCompressed} session summaries older than ${this.keepSummaryDays} days`
        );
      }
    }

    // ── Phase 3: Compress old episode details (> keepSummaryDays) ──
    const oldEpisodes = this.db
      .prepare(
        `SELECT id, details FROM episodes
         WHERE created_at < ?
         AND details IS NOT NULL
         AND length(details) > 200`
      )
      .all(summaryCutoff) as Array<{ id: number; details: string }>;

    if (oldEpisodes.length > 0) {
      const updateDetails = this.db.prepare(
        `UPDATE episodes SET details = NULL WHERE id = ?`
      );

      const tx = this.db.transaction(() => {
        for (const episode of oldEpisodes) {
          updateDetails.run(episode.id);
          stats.episodesCompressed++;
        }
      });

      tx();

      if (stats.episodesCompressed > 0) {
        this.logger.info(
          `Stripped details from ${stats.episodesCompressed} episodes older than ${this.keepSummaryDays} days`
        );
      }
    }

    // ── Phase 4: Delete orphaned embeddings ──
    try {
      // Delete embeddings whose source rows no longer exist
      const orphanedProfile = this.db
        .prepare(
          `DELETE FROM vec_memory
           WHERE source_table = 'profile'
           AND source_id NOT IN (SELECT id FROM profile)`
        )
        .run();

      const orphanedEpisodes = this.db
        .prepare(
          `DELETE FROM vec_memory
           WHERE source_table = 'episodes'
           AND source_id NOT IN (SELECT CAST(id AS TEXT) FROM episodes)`
        )
        .run();

      const orphanedEntities = this.db
        .prepare(
          `DELETE FROM vec_memory
           WHERE source_table = 'entities'
           AND source_id NOT IN (SELECT CAST(id AS TEXT) FROM entities)`
        )
        .run();

      stats.embeddingsDeleted =
        orphanedProfile.changes +
        orphanedEpisodes.changes +
        orphanedEntities.changes;

      if (stats.embeddingsDeleted > 0) {
        this.logger.info(
          `Deleted ${stats.embeddingsDeleted} orphaned embeddings`
        );
      }
    } catch {
      // vec_memory might not exist — that's fine
    }

    return stats;
  }

  /** Get compression stats for status reporting */
  getStats(): {
    lastCompressionAt: string;
    dbSizeEstimate: string;
    chunkCount: number;
    oldChunkCount: number;
  } {
    const lastRun = this.db
      .prepare(`SELECT value FROM mnemo_meta WHERE key = 'last_compression_at'`)
      .get() as { value: string } | undefined;

    const chunkCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM conversation_chunks`).get() as { c: number }
    ).c;

    const cutoff = this.daysAgo(this.keepFullDays);
    const oldChunkCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM conversation_chunks c
           JOIN sessions s ON s.id = c.session_id
           WHERE s.started_at < ?`
        )
        .get(cutoff) as { c: number }
    ).c;

    // Rough size estimate
    const pageCount = this.db.pragma("page_count") as Array<{ page_count: number }>;
    const pageSize = this.db.pragma("page_size") as Array<{ page_size: number }>;
    const sizeBytes =
      (pageCount[0]?.page_count || 0) * (pageSize[0]?.page_size || 4096);
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);

    return {
      lastCompressionAt: lastRun?.value || "never",
      dbSizeEstimate: `${sizeMB}MB`,
      chunkCount,
      oldChunkCount,
    };
  }

  private daysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
  }
}

/** Compress a summary to its first sentence or first 150 chars */
function compressSummary(text: string): string {
  // Try first sentence
  const sentenceEnd = text.search(/[.!?]\s/);
  if (sentenceEnd > 0 && sentenceEnd < 200) {
    return text.slice(0, sentenceEnd + 1);
  }
  // Fall back to truncation
  if (text.length > 150) {
    return text.slice(0, 147) + "...";
  }
  return text;
}

interface CompressionStats {
  chunksDeleted: number;
  embeddingsDeleted: number;
  summariesCompressed: number;
  episodesCompressed: number;
}
