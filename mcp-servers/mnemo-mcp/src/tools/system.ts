/**
 * System tools: configuration management, stats, health checks.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { getDb, getConfig } from "../db.js";
import { getEmbedderInstance } from "../embed.js";
import { getSyncStatus, isVecAvailable } from "@mnemo/shared";
import type { MnemoConfig } from "@mnemo/shared";

const CONFIG_PATH = resolve(
  process.env.MNEMO_CONFIG_PATH || resolve(homedir(), ".mnemo", "config.json")
);

// ─── mnemo_configure ───────────────────────────

export function getConfiguration(): MnemoConfig {
  return getConfig();
}

export function updateConfiguration(
  updates: Partial<MnemoConfig>
): { config: MnemoConfig; changed: string[] } {
  const current = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as MnemoConfig;
  const changed: string[] = [];

  // Apply allowed updates
  if (updates.timezone !== undefined && updates.timezone !== current.timezone) {
    current.timezone = updates.timezone;
    changed.push("timezone");
  }
  if (
    updates.profile_build_interval !== undefined &&
    updates.profile_build_interval !== current.profile_build_interval
  ) {
    current.profile_build_interval = updates.profile_build_interval;
    changed.push("profile_build_interval");
  }
  if (
    updates.compression_keep_full_days !== undefined &&
    updates.compression_keep_full_days !== current.compression_keep_full_days
  ) {
    current.compression_keep_full_days = updates.compression_keep_full_days;
    changed.push("compression_keep_full_days");
  }
  if (
    updates.compression_keep_summary_days !== undefined &&
    updates.compression_keep_summary_days !== current.compression_keep_summary_days
  ) {
    current.compression_keep_summary_days = updates.compression_keep_summary_days;
    changed.push("compression_keep_summary_days");
  }
  if (updates.log_level !== undefined && updates.log_level !== current.log_level) {
    current.log_level = updates.log_level;
    changed.push("log_level");
  }
  if (updates.telegram !== undefined) {
    if (updates.telegram.enabled !== undefined) {
      current.telegram.enabled = updates.telegram.enabled;
      changed.push("telegram.enabled");
    }
    if (updates.telegram.bot_token !== undefined) {
      current.telegram.bot_token = updates.telegram.bot_token;
      changed.push("telegram.bot_token");
    }
    if (updates.telegram.user_id !== undefined) {
      current.telegram.user_id = updates.telegram.user_id;
      changed.push("telegram.user_id");
    }
  }

  if (changed.length > 0) {
    writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + "\n");
  }

  return { config: current, changed };
}

// ─── mnemo_system_stats ────────────────────────

export async function getSystemStats(): Promise<Record<string, unknown>> {
  const db = getDb();
  const config = getConfig();

  const counts = {
    profile_facts: (
      db.prepare(`SELECT COUNT(*) as c FROM profile WHERE category != '_system'`).get() as { c: number }
    ).c,
    episodes: (db.prepare(`SELECT COUNT(*) as c FROM episodes`).get() as { c: number }).c,
    entities: (db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as { c: number }).c,
    relations: (db.prepare(`SELECT COUNT(*) as c FROM entity_relations`).get() as { c: number }).c,
    sessions: (db.prepare(`SELECT COUNT(*) as c FROM sessions`).get() as { c: number }).c,
    conversation_chunks: (
      db.prepare(`SELECT COUNT(*) as c FROM conversation_chunks`).get() as { c: number }
    ).c,
    scheduled_tasks: (
      db.prepare(`SELECT COUNT(*) as c FROM scheduled_tasks WHERE enabled = 1`).get() as { c: number }
    ).c,
    pending_messages: (
      db.prepare(`SELECT COUNT(*) as c FROM messages WHERE status = 'pending'`).get() as { c: number }
    ).c,
    profile_builds: (
      db.prepare(`SELECT COUNT(*) as c FROM profile_builds`).get() as { c: number }
    ).c,
  };

  // Sync status
  const sync = getSyncStatus(config.db_path);

  // Ollama health
  const embedder = getEmbedderInstance();
  const ollamaHealth = await embedder.healthCheck();

  // Vec status
  const vecStatus = isVecAvailable();

  // Meta values
  const meta: Record<string, string> = {};
  const metaRows = db
    .prepare(`SELECT key, value FROM mnemo_meta`)
    .all() as Array<{ key: string; value: string }>;
  for (const row of metaRows) {
    meta[row.key] = row.value;
  }

  return {
    counts,
    sync: {
      provider: sync.syncProvider,
      healthy: sync.healthy,
      dbSize: `${(sync.sizeBytes / 1024 / 1024).toFixed(1)}MB`,
      walSize: `${(sync.walSizeBytes / 1024).toFixed(0)}KB`,
      issues: sync.issues,
    },
    ollama: ollamaHealth,
    vectorSearch: vecStatus,
    meta,
    config: {
      timezone: config.timezone,
      profile_build_interval: config.profile_build_interval,
      telegram_enabled: config.telegram.enabled,
      compression_keep_full_days: config.compression_keep_full_days,
      compression_keep_summary_days: config.compression_keep_summary_days,
    },
  };
}
