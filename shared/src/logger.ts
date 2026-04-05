import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private minLevel: number;
  private logFile: string | null;

  constructor(level: LogLevel = "info", logFile?: string) {
    this.minLevel = LEVELS[level];
    this.logFile = logFile || null;
    if (this.logFile) {
      mkdirSync(dirname(this.logFile), { recursive: true });
    }
  }

  debug(msg: string, data?: unknown): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: unknown): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: unknown): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: unknown): void {
    this.log("error", msg, data);
  }

  private log(level: LogLevel, msg: string, data?: unknown): void {
    if (LEVELS[level] < this.minLevel) return;

    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    const line = data
      ? `${prefix} ${msg} ${JSON.stringify(data)}`
      : `${prefix} ${msg}`;

    if (LEVELS[level] >= LEVELS.warn) {
      console.error(line);
    } else {
      console.log(line);
    }

    if (this.logFile) {
      try {
        appendFileSync(this.logFile, line + "\n");
      } catch {
        // Don't crash on log write failures
      }
    }
  }
}
