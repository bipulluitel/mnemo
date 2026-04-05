/**
 * Profile Trigger
 *
 * Monitors sessions_since_profile_build counter.
 * When threshold is reached, queues a profile rebuild message
 * for the next Cowork session (or sends via Dispatch/Telegram).
 *
 * The actual synthesis is done by Claude — this just triggers it.
 */

import Database from "better-sqlite3";
import { Logger } from "@mnemo/shared";

export class ProfileTrigger {
  private db: Database.Database;
  private logger: Logger;
  private threshold: number;
  private lastCheck: number = 0;
  private checkIntervalMs: number = 60_000; // check every 60s

  constructor(
    db: Database.Database,
    logger: Logger,
    profileBuildInterval: number = 5
  ) {
    this.db = db;
    this.logger = logger;
    this.threshold = profileBuildInterval;

    // Ensure meta keys exist
    this.ensureMeta("sessions_since_profile_build", "0");
    this.ensureMeta("last_profile_build_at", "");
    this.ensureMeta("profile_build_version", "0");
  }

  /** Called every tick. Checks if a rebuild is needed. */
  tick(): void {
    const now = Date.now();
    if (now - this.lastCheck < this.checkIntervalMs) return;
    this.lastCheck = now;

    const counter = this.getMeta("sessions_since_profile_build");
    const count = parseInt(counter, 10) || 0;

    if (count < this.threshold) return;

    // Check we haven't already queued a rebuild message recently
    const pending = this.db
      .prepare(
        `SELECT id FROM messages
         WHERE direction = 'inbound' AND status = 'pending'
         AND content LIKE '%profile rebuild%'
         AND created_at > datetime('now', '-1 hour')`
      )
      .get();

    if (pending) {
      this.logger.debug("Profile rebuild already queued, skipping");
      return;
    }

    this.logger.info(
      `Profile rebuild threshold reached (${count}/${this.threshold} sessions). Queuing rebuild.`
    );

    this.queueRebuild();

    // Reset counter
    this.setMeta("sessions_since_profile_build", "0");
  }

  /** Queue the rebuild message for the next Cowork session */
  private queueRebuild(): void {
    const version = parseInt(this.getMeta("profile_build_version"), 10) || 0;
    const nextVersion = version + 1;

    this.db
      .prepare(
        `INSERT INTO messages (direction, channel, content, status)
         VALUES ('inbound', 'system', ?, 'pending')`
      )
      .run(
        `[Mnemo] Profile rebuild #${nextVersion} requested. Please:\n` +
          `1. Call mnemo_profile to read current profile facts\n` +
          `2. Call mnemo_episodes with limit 30 for recent context\n` +
          `3. Call mnemo_search_entities with query "*" and limit 20\n` +
          `4. Synthesize an updated personality document that covers: identity, work style, ` +
          `current projects, preferences, communication style, key people, and recent context\n` +
          `5. Save with mnemo_remember (category="_system", key="profile_document")\n` +
          `6. Save build timestamp with mnemo_remember (category="_system", key="profile_built_at", ` +
          `value=current ISO timestamp)`
      );

    this.setMeta("profile_build_version", String(nextVersion));
    this.logger.info(`Profile rebuild #${nextVersion} queued`);
  }

  /** Force a rebuild (called via Telegram /rebuild command) */
  forceRebuild(): void {
    this.logger.info("Forced profile rebuild requested");
    this.queueRebuild();
  }

  /** Get current stats */
  getStats(): {
    sessionsSinceLastBuild: number;
    threshold: number;
    lastBuildAt: string;
    buildVersion: number;
  } {
    return {
      sessionsSinceLastBuild:
        parseInt(this.getMeta("sessions_since_profile_build"), 10) || 0,
      threshold: this.threshold,
      lastBuildAt: this.getMeta("last_profile_build_at"),
      buildVersion:
        parseInt(this.getMeta("profile_build_version"), 10) || 0,
    };
  }

  private getMeta(key: string): string {
    const row = this.db
      .prepare(`SELECT value FROM mnemo_meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value || "";
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO mnemo_meta (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value);
  }

  private ensureMeta(key: string, defaultValue: string): void {
    const existing = this.db
      .prepare(`SELECT key FROM mnemo_meta WHERE key = ?`)
      .get(key);
    if (!existing) {
      this.setMeta(key, defaultValue);
    }
  }
}
