/**
 * Telegram Bot
 *
 * Handles direct commands and forwards non-command messages
 * to the messages table for Cowork pickup.
 *
 * Commands:
 *   /status   — Daemon uptime, last session, next task, DB size
 *   /tasks    — Scheduled tasks with next run times
 *   /pause N  — Disable a task
 *   /resume N — Re-enable a task
 *   /memory Q — FTS search, top 5 results
 *   /profile  — Current personality document (truncated)
 *   /rebuild  — Trigger profile rebuild
 *   /forget T — Queue forget request
 *   /yes      — Confirm a pending task
 *   /no       — Decline a pending task
 *   (text)    — Forward to Cowork via queue
 *
 * Security: Only messages from configured user_id are processed.
 */

import { Bot, Context } from "grammy";
import Database from "better-sqlite3";
import { Logger, describeSchedule } from "@mnemo/shared";
import type { ScheduledTask, ProfileFact } from "@mnemo/shared";
import { ProfileTrigger } from "./profile-trigger.js";

export class TelegramBot {
  private bot: Bot;
  private db: Database.Database;
  private logger: Logger;
  private userId: string;
  private profileTrigger: ProfileTrigger;
  private running: boolean = false;

  constructor(
    botToken: string,
    userId: string,
    db: Database.Database,
    logger: Logger,
    profileTrigger: ProfileTrigger
  ) {
    this.bot = new Bot(botToken);
    this.db = db;
    this.logger = logger;
    this.userId = userId;
    this.profileTrigger = profileTrigger;

    this.registerHandlers();
  }

  /** Start the bot (long polling) */
  async start(): Promise<void> {
    this.running = true;
    this.logger.info("Telegram bot starting");

    this.bot.catch((err) => {
      this.logger.error("Telegram bot error", err.error);
    });

    // Start in background — don't block
    this.bot.start({
      onStart: () => {
        this.logger.info("Telegram bot connected");
      },
    });
  }

  /** Stop the bot */
  async stop(): Promise<void> {
    this.running = false;
    await this.bot.stop();
    this.logger.info("Telegram bot stopped");
  }

  /** Send a message to the configured user */
  async sendToUser(text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.userId, text, {
        parse_mode: "Markdown",
      });
    } catch (err: unknown) {
      // Retry without markdown if formatting fails
      try {
        await this.bot.api.sendMessage(this.userId, text);
      } catch (retryErr: unknown) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        this.logger.error(`Failed to send Telegram message: ${msg}`);
      }
    }
  }

  private registerHandlers(): void {
    // Security: only accept messages from configured user
    this.bot.use(async (ctx, next) => {
      const fromId = String(ctx.from?.id || "");
      if (fromId !== this.userId) {
        this.logger.warn(`Rejected message from unknown user: ${fromId}`);
        return;
      }
      await next();
    });

    this.bot.command("status", (ctx) => this.handleStatus(ctx));
    this.bot.command("tasks", (ctx) => this.handleTasks(ctx));
    this.bot.command("pause", (ctx) => this.handlePause(ctx));
    this.bot.command("resume", (ctx) => this.handleResume(ctx));
    this.bot.command("memory", (ctx) => this.handleMemory(ctx));
    this.bot.command("profile", (ctx) => this.handleProfile(ctx));
    this.bot.command("rebuild", (ctx) => this.handleRebuild(ctx));
    this.bot.command("forget", (ctx) => this.handleForget(ctx));
    this.bot.command("yes", (ctx) => this.handleConfirm(ctx, true));
    this.bot.command("no", (ctx) => this.handleConfirm(ctx, false));
    this.bot.command("start", (ctx) =>
      ctx.reply(
        "Mnemo connected. I'll forward your messages to Claude.\n\n" +
          "Commands: /status /tasks /memory /profile /rebuild"
      )
    );

    // Non-command messages: forward to Cowork queue
    this.bot.on("message:text", (ctx) => this.handleText(ctx));
  }

  // ─── Command handlers ─────────────────────────

  private async handleStatus(ctx: Context): Promise<void> {
    const taskCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM scheduled_tasks WHERE enabled = 1`).get() as { c: number }
    ).c;
    const factCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM profile WHERE category != '_system'`).get() as { c: number }
    ).c;
    const episodeCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM episodes`).get() as { c: number }
    ).c;
    const entityCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as { c: number }
    ).c;
    const sessionCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM sessions`).get() as { c: number }
    ).c;
    const pendingMsgs = (
      this.db.prepare(`SELECT COUNT(*) as c FROM messages WHERE status = 'pending'`).get() as { c: number }
    ).c;

    const lastSession = this.db
      .prepare(`SELECT started_at, summary FROM sessions ORDER BY started_at DESC LIMIT 1`)
      .get() as { started_at: string; summary: string } | undefined;

    const nextTask = this.db
      .prepare(
        `SELECT name, next_run_at FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL
         ORDER BY next_run_at LIMIT 1`
      )
      .get() as { name: string; next_run_at: string } | undefined;

    const stats = this.profileTrigger.getStats();

    let msg = `📊 *Mnemo Status*\n\n`;
    msg += `Facts: ${factCount} | Episodes: ${episodeCount}\n`;
    msg += `Entities: ${entityCount} | Sessions: ${sessionCount}\n`;
    msg += `Active tasks: ${taskCount} | Pending msgs: ${pendingMsgs}\n`;
    msg += `Profile build: #${stats.buildVersion}`;
    if (stats.lastBuildAt) msg += ` (${stats.lastBuildAt})`;
    msg += `\n`;

    if (lastSession) {
      msg += `\nLast session: ${lastSession.started_at}\n`;
      if (lastSession.summary) {
        const summary = lastSession.summary.length > 100
          ? lastSession.summary.slice(0, 100) + "..."
          : lastSession.summary;
        msg += `  ${summary}\n`;
      }
    }

    if (nextTask) {
      msg += `\nNext task: ${nextTask.name} @ ${nextTask.next_run_at}`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => ctx.reply(msg));
  }

  private async handleTasks(ctx: Context): Promise<void> {
    const tasks = this.db
      .prepare(
        `SELECT id, name, schedule, enabled, next_run_at, last_status
         FROM scheduled_tasks ORDER BY next_run_at`
      )
      .all() as Array<
      Pick<ScheduledTask, "id" | "name" | "schedule" | "enabled" | "next_run_at" | "last_status">
    >;

    if (tasks.length === 0) {
      await ctx.reply("No scheduled tasks.");
      return;
    }

    let msg = `📋 *Scheduled Tasks*\n\n`;
    for (const t of tasks) {
      const status = t.enabled ? "✅" : "⏸";
      const sched = describeSchedule(t.schedule);
      msg += `${status} *#${t.id}* ${t.name}\n`;
      msg += `  ${sched}`;
      if (t.next_run_at) msg += ` | next: ${t.next_run_at}`;
      if (t.last_status) msg += ` | ${t.last_status}`;
      msg += `\n`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => ctx.reply(msg));
  }

  private async handlePause(ctx: Context): Promise<void> {
    const id = parseInt(ctx.match as string, 10);
    if (!id) {
      await ctx.reply("Usage: /pause <task_id>");
      return;
    }

    const result = this.db
      .prepare(`UPDATE scheduled_tasks SET enabled = 0, updated_at = datetime('now') WHERE id = ?`)
      .run(id);

    if (result.changes > 0) {
      await ctx.reply(`⏸ Task #${id} paused.`);
    } else {
      await ctx.reply(`Task #${id} not found.`);
    }
  }

  private async handleResume(ctx: Context): Promise<void> {
    const id = parseInt(ctx.match as string, 10);
    if (!id) {
      await ctx.reply("Usage: /resume <task_id>");
      return;
    }

    const result = this.db
      .prepare(`UPDATE scheduled_tasks SET enabled = 1, updated_at = datetime('now') WHERE id = ?`)
      .run(id);

    if (result.changes > 0) {
      await ctx.reply(`▶️ Task #${id} resumed.`);
    } else {
      await ctx.reply(`Task #${id} not found.`);
    }
  }

  private async handleMemory(ctx: Context): Promise<void> {
    const query = (ctx.match as string || "").trim();
    if (!query) {
      await ctx.reply("Usage: /memory <search query>");
      return;
    }

    // FTS search across profile and episodes
    const profileHits = this.db
      .prepare(
        `SELECT p.category, p.key, p.value FROM profile_fts f
         JOIN profile p ON p.rowid = f.rowid
         WHERE profile_fts MATCH ? LIMIT 3`
      )
      .all(query) as Array<{ category: string; key: string; value: string }>;

    const episodeHits = this.db
      .prepare(
        `SELECT e.summary, e.created_at FROM episodes_fts f
         JOIN episodes e ON e.id = f.rowid
         WHERE episodes_fts MATCH ? ORDER BY rank LIMIT 3`
      )
      .all(query) as Array<{ summary: string; created_at: string }>;

    if (profileHits.length === 0 && episodeHits.length === 0) {
      await ctx.reply(`No results for "${query}".`);
      return;
    }

    let msg = `🔍 *Results for "${query}"*\n\n`;

    if (profileHits.length > 0) {
      msg += `*Profile:*\n`;
      for (const h of profileHits) {
        msg += `- [${h.category}] ${h.key}: ${h.value}\n`;
      }
    }

    if (episodeHits.length > 0) {
      msg += `\n*Episodes:*\n`;
      for (const h of episodeHits) {
        msg += `- ${h.created_at}: ${h.summary}\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => ctx.reply(msg));
  }

  private async handleProfile(ctx: Context): Promise<void> {
    const doc = this.db
      .prepare(`SELECT value FROM mnemo_meta WHERE key = 'profile_document'`)
      .get() as { value: string } | undefined;

    if (!doc) {
      // Fall back to listing facts
      const facts = this.db
        .prepare(`SELECT category, key, value FROM profile WHERE category != '_system' ORDER BY category LIMIT 20`)
        .all() as Array<{ category: string; key: string; value: string }>;

      if (facts.length === 0) {
        await ctx.reply("No profile built yet. Start a Cowork session to build one.");
        return;
      }

      let msg = `👤 *Profile Facts*\n\n`;
      for (const f of facts) {
        msg += `- [${f.category}] ${f.key}: ${f.value}\n`;
      }
      await ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => ctx.reply(msg));
      return;
    }

    // Truncate long profile documents for Telegram
    const maxLen = 3500;
    let text = doc.value;
    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + "\n\n... (truncated)";
    }

    await ctx.reply(`👤 *Profile*\n\n${text}`, { parse_mode: "Markdown" }).catch(() =>
      ctx.reply(`Profile:\n\n${text}`)
    );
  }

  private async handleRebuild(ctx: Context): Promise<void> {
    this.profileTrigger.forceRebuild();
    await ctx.reply("🧠 Profile rebuild queued. Will be processed in the next Cowork session.");
  }

  private async handleForget(ctx: Context): Promise<void> {
    const query = (ctx.match as string || "").trim();
    if (!query) {
      await ctx.reply("Usage: /forget <topic>");
      return;
    }

    // Queue as inbound message for Cowork to handle
    this.db
      .prepare(
        `INSERT INTO messages (direction, channel, content, status)
         VALUES ('inbound', 'telegram', ?, 'pending')`
      )
      .run(
        `[Mnemo] User requested via Telegram: forget everything about "${query}". ` +
          `Use mnemo_forget to find and remove matching memories. Ask for confirmation before deleting.`
      );

    await ctx.reply(`🗑 Forget request for "${query}" queued for next session.`);
  }

  private async handleConfirm(ctx: Context, confirmed: boolean): Promise<void> {
    if (confirmed) {
      this.db
        .prepare(
          `INSERT INTO messages (direction, channel, content, status)
           VALUES ('inbound', 'telegram', ?, 'pending')`
        )
        .run("[Mnemo] User confirmed the pending task via Telegram. Please execute it.");
      await ctx.reply("✅ Confirmed. Task will execute in the next session.");
    } else {
      this.db
        .prepare(
          `INSERT INTO messages (direction, channel, content, status)
           VALUES ('inbound', 'telegram', ?, 'pending')`
        )
        .run("[Mnemo] User declined the pending task via Telegram. Skip it.");
      await ctx.reply("❌ Declined. Task skipped.");
    }
  }

  private async handleText(ctx: Context): Promise<void> {
    const text = ctx.message?.text;
    if (!text) return;

    // Queue as inbound message
    this.db
      .prepare(
        `INSERT INTO messages (direction, channel, content, status)
         VALUES ('inbound', 'telegram', ?, 'pending')`
      )
      .run(text);

    await ctx.reply("📨 Message queued for Claude.");
  }
}
