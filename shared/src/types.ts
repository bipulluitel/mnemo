// ═══════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════

export interface ProfileFact {
  id: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
  source: "explicit" | "inferred" | "observed";
  created_at: string;
  updated_at: string;
  version: number;
}

export interface ProfileHistory {
  id: number;
  profile_id: string;
  old_value: string | null;
  new_value: string;
  reason: string | null;
  changed_at: string;
}

export interface ProfileBuild {
  id: number;
  version: number;
  document: string;
  fact_count: number;
  episode_count: number;
  entity_count: number;
  session_count: number;
  built_at: string;
}

// ═══════════════════════════════════════════════
// EPISODES
// ═══════════════════════════════════════════════

export interface Episode {
  id: number;
  summary: string;
  details: string | null;
  tags: string | null; // JSON array stored as string
  importance: number;
  session_id: string | null;
  created_at: string;
}

// ═══════════════════════════════════════════════
// ENTITIES
// ═══════════════════════════════════════════════

export interface Entity {
  id: number;
  name: string;
  type: string;
  attributes: string | null; // JSON object stored as string
  last_mentioned_at: string | null;
  mention_count: number;
  created_at: string;
  updated_at: string;
}

export interface EntityRelation {
  id: number;
  entity_a: number;
  entity_b: number;
  relation: string;
  context: string | null;
  created_at: string;
}

// ═══════════════════════════════════════════════
// CONVERSATIONS
// ═══════════════════════════════════════════════

export interface Session {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  summary: string | null;
  key_decisions: string | null; // JSON array
  key_facts_learned: string | null; // JSON array
  topic_tags: string | null; // JSON array
  message_count: number;
  created_at: string;
}

export interface ConversationChunk {
  id: number;
  session_id: string;
  role: string;
  content: string;
  chunk_index: number;
  created_at: string;
}

// ═══════════════════════════════════════════════
// SCHEDULED TASKS
// ═══════════════════════════════════════════════

export interface ScheduledTask {
  id: number;
  name: string;
  description: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  requires_confirmation: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  last_output: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRun {
  id: number;
  task_id: number;
  started_at: string;
  ended_at: string | null;
  status: "running" | "success" | "failed" | "skipped";
  output: string | null;
  error: string | null;
}

// ═══════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════

export interface Message {
  id: number;
  direction: "inbound" | "outbound";
  channel: string;
  content: string;
  status: "pending" | "delivered" | "failed";
  session_id: string | null;
  created_at: string;
  delivered_at: string | null;
}

// ═══════════════════════════════════════════════
// SYSTEM
// ═══════════════════════════════════════════════

export interface MnemoMeta {
  key: string;
  value: string;
  updated_at: string;
}

// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════

export interface MnemoConfig {
  db_path: string;
  ollama_url: string;
  ollama_model: string;
  cowork_data_dir: string;
  timezone: string;
  profile_build_interval: number;
  compression_keep_full_days: number;
  compression_keep_summary_days: number;
  task_trigger_method?: "dispatch" | "telegram" | "queue";
  telegram: {
    enabled: boolean;
    bot_token: string;
    user_id: string;
    channel_bridge?: boolean;
  };
  log_level?: "debug" | "info" | "warn" | "error";
  log_file?: string;
}

// ═══════════════════════════════════════════════
// RECALL RESULTS
// ═══════════════════════════════════════════════

export interface RecallResult {
  source_table: string;
  source_id: number;
  content: string;
  score: number;
  created_at: string;
  metadata?: Record<string, unknown>;
}
