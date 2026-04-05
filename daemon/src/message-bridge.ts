/**
 * Message Bridge
 *
 * Delivers pending outbound messages via Telegram.
 * Polls the messages table for outbound messages with status='pending'
 * and sends them through the Telegram bot.
 */

import Database from "better-sqlite3";
import { Logger } from "@mnemo/shared";
import type { Message } from "@mnemo/shared";
import { TelegramBot } from "./telegram-bot.js";

export class MessageBridge {
  private db: Database.Database;
  private logger: Logger;
  private telegramBot: TelegramBot | null;
  private lastTick: number = 0;
  private tickIntervalMs: number = 15_000; // check every 15s

  constructor(
    db: Database.Database,
    logger: Logger,
    telegramBot: TelegramBot | null
  ) {
    this.db = db;
    this.logger = logger;
    this.telegramBot = telegramBot;
  }

  /** Called every daemon tick. Delivers pending outbound messages. */
  async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTick < this.tickIntervalMs) return;
    this.lastTick = now;

    const pending = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'outbound' AND status = 'pending'
         ORDER BY created_at
         LIMIT 10`
      )
      .all() as Message[];

    if (pending.length === 0) return;

    for (const msg of pending) {
      await this.deliver(msg);
    }
  }

  private async deliver(msg: Message): Promise<void> {
    const channel = msg.channel || "telegram";

    if (channel === "telegram" && this.telegramBot) {
      try {
        await this.telegramBot.sendToUser(msg.content);
        this.markDelivered(msg.id);
        this.logger.debug(`Delivered outbound message #${msg.id} via Telegram`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to deliver message #${msg.id}: ${errMsg}`);
        this.markFailed(msg.id);
      }
    } else {
      // No delivery channel available — leave as pending
      // Will be picked up when Telegram is configured or next session starts
      this.logger.debug(
        `No delivery channel for outbound message #${msg.id} (channel=${channel})`
      );
    }
  }

  private markDelivered(id: number): void {
    this.db
      .prepare(
        `UPDATE messages SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?`
      )
      .run(id);
  }

  private markFailed(id: number): void {
    this.db
      .prepare(`UPDATE messages SET status = 'failed' WHERE id = ?`)
      .run(id);
  }

  /** Get bridge stats */
  getStats(): {
    pendingOutbound: number;
    pendingInbound: number;
    deliveredToday: number;
  } {
    const pendingOut = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM messages WHERE direction = 'outbound' AND status = 'pending'`
        )
        .get() as { c: number }
    ).c;
    const pendingIn = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM messages WHERE direction = 'inbound' AND status = 'pending'`
        )
        .get() as { c: number }
    ).c;
    const delivered = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM messages
           WHERE status = 'delivered' AND delivered_at > datetime('now', '-24 hours')`
        )
        .get() as { c: number }
    ).c;

    return {
      pendingOutbound: pendingOut,
      pendingInbound: pendingIn,
      deliveredToday: delivered,
    };
  }
}
