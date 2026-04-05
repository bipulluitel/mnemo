/**
 * Session Watcher
 *
 * Monitors the Cowork transcript directory for completed sessions.
 * When a session file hasn't been modified for >2 minutes (session ended):
 * 1. Reads the transcript
 * 2. Chunks it into conversation_chunks
 * 3. Generates embeddings via Ollama and stores in vec_memory
 * 4. Increments sessions_since_profile_build counter
 */

import Database from "better-sqlite3";
import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { resolve, basename } from "path";
import {
  Embedder,
  storeEmbedding,
  isVecAvailable,
  Logger,
} from "@mnemo/shared";

const IDLE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const CHUNK_MAX_LENGTH = 2000; // chars per chunk

interface WatcherState {
  /** session file path → last mtime we saw */
  knownFiles: Map<string, number>;
  /** session IDs we've already processed */
  processed: Set<string>;
}

export class SessionWatcher {
  private db: Database.Database;
  private embedder: Embedder;
  private logger: Logger;
  private transcriptDir: string;
  private state: WatcherState;

  constructor(
    db: Database.Database,
    embedder: Embedder,
    logger: Logger,
    coworkDataDir: string
  ) {
    this.db = db;
    this.embedder = embedder;
    this.logger = logger;
    this.transcriptDir = coworkDataDir;
    this.state = {
      knownFiles: new Map(),
      processed: new Set(),
    };

    // Load already-processed session IDs from DB
    const rows = this.db
      .prepare(`SELECT id FROM sessions`)
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      this.state.processed.add(row.id);
    }
  }

  /** Called every tick (30–60s). Scans for completed sessions. */
  async tick(): Promise<void> {
    if (!existsSync(this.transcriptDir)) {
      return;
    }

    const now = Date.now();
    let files: string[];

    try {
      files = readdirSync(this.transcriptDir).filter(
        (f) => f.endsWith(".json") || f.endsWith(".jsonl")
      );
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = resolve(this.transcriptDir, file);
      const sessionId = basename(file, ".json").replace(".jsonl", "");

      if (this.state.processed.has(sessionId)) continue;

      try {
        const stat = statSync(filePath);
        const mtime = stat.mtimeMs;
        const prevMtime = this.state.knownFiles.get(filePath);

        // Update known mtime
        this.state.knownFiles.set(filePath, mtime);

        // Only process if file has been idle for >2 minutes
        // and its mtime hasn't changed since our last check
        if (prevMtime !== undefined && mtime === prevMtime && now - mtime > IDLE_THRESHOLD_MS) {
          await this.processSession(sessionId, filePath);
          this.state.processed.add(sessionId);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to check session file ${file}: ${msg}`);
      }
    }
  }

  private async processSession(sessionId: string, filePath: string): Promise<void> {
    this.logger.info(`Processing session: ${sessionId}`);

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      this.logger.warn(`Could not read session file: ${filePath}`);
      return;
    }

    // Parse the transcript — handle both JSON and JSONL formats
    const messages = this.parseTranscript(content);
    if (messages.length === 0) {
      this.logger.warn(`No messages found in session: ${sessionId}`);
      return;
    }

    // Ensure session row exists
    const existingSession = this.db
      .prepare(`SELECT id FROM sessions WHERE id = ?`)
      .get(sessionId);

    if (!existingSession) {
      this.db
        .prepare(
          `INSERT INTO sessions (id, started_at, message_count)
           VALUES (?, datetime('now'), ?)`
        )
        .run(sessionId, messages.length);
    }

    // Chunk and store
    const chunks = this.chunkMessages(messages);
    const insertChunk = this.db.prepare(
      `INSERT INTO conversation_chunks (session_id, role, content, chunk_index)
       VALUES (?, ?, ?, ?)`
    );

    const insertTx = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        insertChunk.run(sessionId, chunks[i].role, chunks[i].content, i);
      }
    });

    insertTx();
    this.logger.info(`Stored ${chunks.length} chunks for session ${sessionId}`);

    // Generate embeddings for each chunk
    if (isVecAvailable()) {
      await this.embedChunks(sessionId, chunks);
    }

    // Increment profile rebuild counter
    this.db
      .prepare(
        `UPDATE mnemo_meta SET
           value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
           updated_at = datetime('now')
         WHERE key = 'sessions_since_profile_build'`
      )
      .run();

    // Check if profile rebuild is needed
    const counter = this.db
      .prepare(`SELECT value FROM mnemo_meta WHERE key = 'sessions_since_profile_build'`)
      .get() as { value: string } | undefined;

    const interval = this.db
      .prepare(`SELECT value FROM mnemo_meta WHERE key = 'profile_build_interval'`)
      .get() as { value: string } | undefined;

    const count = counter ? parseInt(counter.value, 10) : 0;
    const threshold = interval ? parseInt(interval.value, 10) : 5;

    if (count >= threshold) {
      this.logger.info("Profile rebuild threshold reached, queuing rebuild message");
      this.db
        .prepare(
          `INSERT INTO messages (direction, channel, content, status)
           VALUES ('inbound', 'system', ?, 'pending')`
        )
        .run(
          "Mnemo profile rebuild requested. Read my full profile with mnemo_profile, " +
            "review recent episodes with mnemo_episodes (limit 30), review entities with " +
            "mnemo_search_entities, and write an updated personality document using " +
            "mnemo_remember with category _system and key profile_document."
        );

      this.db
        .prepare(
          `UPDATE mnemo_meta SET value = '0', updated_at = datetime('now')
           WHERE key = 'sessions_since_profile_build'`
        )
        .run();
    }

    this.logger.info(`Session ${sessionId} processed successfully`);
  }

  /**
   * Parse a transcript file into messages.
   * Supports JSON array format and JSONL (one JSON object per line).
   */
  private parseTranscript(
    content: string
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    try {
      // Try JSON array first
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        for (const msg of parsed) {
          if (msg.role && msg.content) {
            const text =
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content);
            messages.push({ role: msg.role, content: text });
          }
        }
        return messages;
      }
    } catch {
      // Not valid JSON array — try JSONL
    }

    // JSONL format
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.role && msg.content) {
          const text =
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
          messages.push({ role: msg.role, content: text });
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return messages;
  }

  /**
   * Chunk messages into pieces suitable for embedding.
   * Groups consecutive messages and splits long ones.
   */
  private chunkMessages(
    messages: Array<{ role: string; content: string }>
  ): Array<{ role: string; content: string }> {
    const chunks: Array<{ role: string; content: string }> = [];

    for (const msg of messages) {
      if (msg.content.length <= CHUNK_MAX_LENGTH) {
        chunks.push(msg);
      } else {
        // Split long messages by paragraphs, then by sentences
        const parts = splitText(msg.content, CHUNK_MAX_LENGTH);
        for (const part of parts) {
          chunks.push({ role: msg.role, content: part });
        }
      }
    }

    return chunks;
  }

  /** Generate embeddings for chunks and store in vec_memory */
  private async embedChunks(
    sessionId: string,
    chunks: Array<{ role: string; content: string }>
  ): Promise<void> {
    // Get chunk IDs from DB (just inserted)
    const rows = this.db
      .prepare(
        `SELECT id, chunk_index FROM conversation_chunks
         WHERE session_id = ? ORDER BY chunk_index`
      )
      .all(sessionId) as Array<{ id: number; chunk_index: number }>;

    if (rows.length === 0) return;

    // Batch embed
    const texts = chunks.map((c) => `[${c.role}] ${c.content}`);

    try {
      const embeddings = await this.embedder.embedBatch(texts);

      for (let i = 0; i < rows.length && i < embeddings.length; i++) {
        storeEmbedding(
          this.db,
          "conversation_chunks",
          rows[i].id,
          embeddings[i]
        );
      }

      this.logger.info(
        `Embedded ${embeddings.length} chunks for session ${sessionId}`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to embed chunks for ${sessionId}: ${msg}`);
    }
  }
}

/** Split text into chunks respecting paragraph and sentence boundaries */
function splitText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxLen) {
      current += (current ? "\n\n" : "") + para;
    } else {
      if (current) chunks.push(current);
      if (para.length <= maxLen) {
        current = para;
      } else {
        // Split by sentences
        const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
        current = "";
        for (const sent of sentences) {
          if (current.length + sent.length <= maxLen) {
            current += sent;
          } else {
            if (current) chunks.push(current);
            current = sent.length > maxLen ? sent.slice(0, maxLen) : sent;
          }
        }
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
