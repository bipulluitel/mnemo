import { getDb } from "../db.js";
import type { Message } from "@mnemo/shared";

// ─── mnemo_send_message ────────────────────────

export function sendMessage(
  content: string,
  channel: string = "telegram"
): Message {
  const db = getDb();

  const result = db
    .prepare(
      `INSERT INTO messages (direction, channel, content, status)
       VALUES ('outbound', ?, ?, 'pending')`
    )
    .run(channel, content);

  return db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .get(result.lastInsertRowid) as Message;
}

// ─── mnemo_check_messages ──────────────────────

export function checkMessages(channel?: string): Message[] {
  const db = getDb();

  if (channel) {
    return db
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'inbound' AND status = 'pending' AND channel = ?
         ORDER BY created_at`
      )
      .all(channel) as Message[];
  }

  return db
    .prepare(
      `SELECT * FROM messages
       WHERE direction = 'inbound' AND status = 'pending'
       ORDER BY created_at`
    )
    .all() as Message[];
}

/** Mark messages as delivered (called after Claude processes them) */
export function markDelivered(messageIds: number[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE messages SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?`
  );

  const tx = db.transaction(() => {
    for (const id of messageIds) {
      stmt.run(id);
    }
  });

  tx();
}
