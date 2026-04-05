/**
 * Task Runner — Cron engine for scheduled tasks.
 *
 * Every tick (60s):
 * 1. Query scheduled_tasks where next_run_at <= now AND enabled = 1
 * 2. For each due task:
 *    - If requires_confirmation: queue a confirmation message
 *    - Otherwise: queue the task prompt as an inbound message for Cowork
 * 3. Log execution to task_runs
 * 4. Calculate and store next_run_at
 *
 * Execution methods (priority order):
 *   a. Dispatch (v0.5) — send directly to Cowork
 *   b. Telegram (v0.5) — send via bot
 *   c. Queue (default) — store as pending inbound message for next session
 */

import Database from "better-sqlite3";
import { nextRunTime, describeSchedule, Logger } from "@mnemo/shared";
import type { ScheduledTask } from "@mnemo/shared";

export class TaskRunner {
  private db: Database.Database;
  private logger: Logger;
  private lastTick: number = 0;
  private tickIntervalMs: number = 60_000;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  /** Called every daemon tick. Internally throttled to 60s. */
  async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTick < this.tickIntervalMs) return;
    this.lastTick = now;

    const dueTasks = this.getDueTasks();
    if (dueTasks.length === 0) return;

    this.logger.info(`${dueTasks.length} task(s) due`);

    for (const task of dueTasks) {
      try {
        await this.executeTask(task);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Task '${task.name}' (id=${task.id}) failed: ${msg}`);
        this.logRun(task.id, "failed", null, msg);
      }

      // Always advance next_run_at even if execution failed
      this.advanceSchedule(task);
    }
  }

  /** Get all enabled tasks that are due now */
  private getDueTasks(): ScheduledTask[] {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at`
      )
      .all(now) as ScheduledTask[];
  }

  /** Execute a single task */
  private async executeTask(task: ScheduledTask): Promise<void> {
    this.logger.info(`Executing task '${task.name}' (id=${task.id})`);

    const runId = this.logRun(task.id, "running");

    if (task.requires_confirmation) {
      // Queue a confirmation request
      this.db
        .prepare(
          `INSERT INTO messages (direction, channel, content, status)
           VALUES ('outbound', 'telegram', ?, 'pending')`
        )
        .run(
          `📋 Task '${task.name}' is due.\n\n` +
            `${task.description}\n\n` +
            `Run it? Reply /yes or /no`
        );

      // Also queue as inbound so Cowork sees it next session
      this.db
        .prepare(
          `INSERT INTO messages (direction, channel, content, status)
           VALUES ('inbound', 'system', ?, 'pending')`
        )
        .run(
          `[Mnemo] Scheduled task '${task.name}' needs confirmation before running.\n` +
            `Task: ${task.description}\n` +
            `Schedule: ${describeSchedule(task.schedule)}\n` +
            `Ask the user if they want to proceed.`
        );

      this.completeRun(runId, "success", "Confirmation requested");
      this.updateTaskStatus(task.id, "awaiting_confirmation");
      return;
    }

    // Queue the task as an inbound message for Cowork
    this.db
      .prepare(
        `INSERT INTO messages (direction, channel, content, status)
         VALUES ('inbound', 'system', ?, 'pending')`
      )
      .run(
        `[Mnemo] Scheduled task '${task.name}' is due (${describeSchedule(task.schedule)}).\n\n` +
          `Please execute:\n${task.description}`
      );

    // Also send notification via outbound message (Telegram, if configured)
    this.db
      .prepare(
        `INSERT INTO messages (direction, channel, content, status)
         VALUES ('outbound', 'telegram', ?, 'pending')`
      )
      .run(`✅ Task '${task.name}' queued for execution.`);

    this.completeRun(runId, "success", "Queued for next session");
    this.updateTaskStatus(task.id, "queued");
  }

  /** Calculate and store the next run time */
  private advanceSchedule(task: ScheduledTask): void {
    try {
      const next = nextRunTime(task.schedule, task.timezone);
      this.db
        .prepare(
          `UPDATE scheduled_tasks SET next_run_at = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(next.toISOString(), task.id);

      this.logger.debug(
        `Task '${task.name}' next run: ${next.toISOString()}`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to calculate next run for task '${task.name}': ${msg}`
      );
      // Disable the task to prevent infinite failures
      this.db
        .prepare(
          `UPDATE scheduled_tasks SET enabled = 0, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(task.id);
      this.logger.warn(`Task '${task.name}' disabled due to schedule error`);
    }
  }

  /** Log the start of a task run, return the run ID */
  private logRun(
    taskId: number,
    status: string,
    output?: string | null,
    error?: string | null
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO task_runs (task_id, started_at, status, output, error)
         VALUES (?, datetime('now'), ?, ?, ?)`
      )
      .run(taskId, status, output || null, error || null);
    return result.lastInsertRowid as number;
  }

  /** Update a task run as completed */
  private completeRun(
    runId: number,
    status: string,
    output?: string | null,
    error?: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE task_runs SET ended_at = datetime('now'), status = ?, output = ?, error = ?
         WHERE id = ?`
      )
      .run(status, output || null, error || null, runId);
  }

  /** Update the task's last_status */
  private updateTaskStatus(taskId: number, status: string): void {
    this.db
      .prepare(
        `UPDATE scheduled_tasks SET
           last_run_at = datetime('now'),
           last_status = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(status, taskId);
  }

  /** Get runner stats */
  getStats(): {
    totalTasks: number;
    enabledTasks: number;
    nextDueTask: { name: string; next_run_at: string } | null;
    recentRuns: number;
  } {
    const total = (
      this.db.prepare(`SELECT COUNT(*) as c FROM scheduled_tasks`).get() as { c: number }
    ).c;
    const enabled = (
      this.db
        .prepare(`SELECT COUNT(*) as c FROM scheduled_tasks WHERE enabled = 1`)
        .get() as { c: number }
    ).c;
    const nextDue = this.db
      .prepare(
        `SELECT name, next_run_at FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL
         ORDER BY next_run_at LIMIT 1`
      )
      .get() as { name: string; next_run_at: string } | undefined;
    const recentRuns = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM task_runs
           WHERE started_at > datetime('now', '-24 hours')`
        )
        .get() as { c: number }
    ).c;

    return {
      totalTasks: total,
      enabledTasks: enabled,
      nextDueTask: nextDue || null,
      recentRuns,
    };
  }
}
