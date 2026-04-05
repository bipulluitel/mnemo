import { getDb } from "../db.js";
import { resolveSchedule, nextRunTime, describeSchedule } from "@mnemo/shared";
import type { ScheduledTask, TaskRun } from "@mnemo/shared";

// ─── mnemo_schedule ────────────────────────────

export function schedule(
  name: string,
  description: string,
  scheduleInput: string,
  timezone: string = "UTC",
  requiresConfirmation: boolean = false
): ScheduledTask & { description_human: string } {
  const db = getDb();
  const cron = resolveSchedule(scheduleInput);
  const next = nextRunTime(cron, timezone);

  const result = db
    .prepare(
      `INSERT INTO scheduled_tasks (name, description, schedule, timezone, requires_confirmation, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(name, description, cron, timezone, requiresConfirmation ? 1 : 0, next.toISOString());

  const task = db
    .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
    .get(result.lastInsertRowid) as ScheduledTask;

  return { ...task, description_human: describeSchedule(cron) };
}

// ─── mnemo_list_tasks ──────────────────────────

export function listTasks(enabledOnly: boolean = false): ScheduledTask[] {
  const db = getDb();

  if (enabledOnly) {
    return db
      .prepare(`SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY next_run_at`)
      .all() as ScheduledTask[];
  }

  return db
    .prepare(`SELECT * FROM scheduled_tasks ORDER BY next_run_at`)
    .all() as ScheduledTask[];
}

// ─── mnemo_update_task ─────────────────────────

export function updateTask(
  id: number,
  fields: Partial<Pick<ScheduledTask, "name" | "description" | "schedule" | "timezone" | "enabled" | "requires_confirmation">>
): ScheduledTask {
  const db = getDb();

  const existing = db
    .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
    .get(id) as ScheduledTask | undefined;

  if (!existing) throw new Error(`Task ${id} not found`);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) {
    updates.push("name = ?");
    values.push(fields.name);
  }
  if (fields.description !== undefined) {
    updates.push("description = ?");
    values.push(fields.description);
  }
  if (fields.schedule !== undefined) {
    const cron = resolveSchedule(fields.schedule);
    updates.push("schedule = ?");
    values.push(cron);
    const next = nextRunTime(cron, fields.timezone || existing.timezone);
    updates.push("next_run_at = ?");
    values.push(next.toISOString());
  }
  if (fields.timezone !== undefined) {
    updates.push("timezone = ?");
    values.push(fields.timezone);
  }
  if (fields.enabled !== undefined) {
    updates.push("enabled = ?");
    values.push(fields.enabled ? 1 : 0);
  }
  if (fields.requires_confirmation !== undefined) {
    updates.push("requires_confirmation = ?");
    values.push(fields.requires_confirmation ? 1 : 0);
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(
      `UPDATE scheduled_tasks SET ${updates.join(", ")} WHERE id = ?`
    ).run(...values);
  }

  return db
    .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
    .get(id) as ScheduledTask;
}

// ─── mnemo_delete_task ─────────────────────────

export function deleteTask(id: number): { deleted: boolean } {
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM scheduled_tasks WHERE id = ?`)
    .run(id);
  return { deleted: result.changes > 0 };
}

// ─── mnemo_task_history ────────────────────────

export function taskHistory(taskId: number, limit: number = 10): TaskRun[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(taskId, limit) as TaskRun[];
}
