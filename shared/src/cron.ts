/** Resolve schedule aliases to 5-field cron expressions */
export function resolveSchedule(input: string): string {
  const trimmed = input.trim();

  // Raw cron passthrough (5 fields)
  if (/^[\d*,\/-]+\s+[\d*,\/-]+\s+[\d*,\/-]+\s+[\d*,\/-]+\s+[\d*,\/-]+$/.test(trimmed)) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();

  if (lower === "@hourly") return "0 * * * *";
  if (lower === "@weekly") return "0 9 * * 1";
  if (lower === "@monthly") return "0 9 1 * *";

  // @daily or @daily HH:MM
  const dailyMatch = lower.match(/^@daily(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (dailyMatch) {
    const hour = dailyMatch[1] ? parseInt(dailyMatch[1], 10) : 8;
    const minute = dailyMatch[2] ? parseInt(dailyMatch[2], 10) : 0;
    return `${minute} ${hour} * * *`;
  }

  // @weekdays or @weekdays HH:MM
  const weekdaysMatch = lower.match(/^@weekdays(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (weekdaysMatch) {
    const hour = weekdaysMatch[1] ? parseInt(weekdaysMatch[1], 10) : 9;
    const minute = weekdaysMatch[2] ? parseInt(weekdaysMatch[2], 10) : 0;
    return `${minute} ${hour} * * 1-5`;
  }

  throw new Error(
    `Unknown schedule format: "${input}". Use @hourly, @daily [HH:MM], @weekdays [HH:MM], @weekly, @monthly, or a 5-field cron expression.`
  );
}

/** Calculate next run time from a cron expression */
export function nextRunTime(cron: string, timezone: string, after?: Date): Date {
  const now = after || new Date();
  const fields = cron.split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron: ${cron}`);

  const [minF, hourF, domF, monF, dowF] = fields;

  // Simple forward scan — check each minute for up to 366 days
  const candidate = new Date(now.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (
      matchField(minF, candidate.getMinutes()) &&
      matchField(hourF, candidate.getHours()) &&
      matchField(domF, candidate.getDate()) &&
      matchField(monF, candidate.getMonth() + 1) &&
      matchField(dowF, candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`Could not find next run time for cron: ${cron}`);
}

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    // Range with optional step: 1-5/2
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
      if (value >= start && value <= end && (value - start) % step === 0) return true;
      continue;
    }

    // Step: */2
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      if (value % parseInt(stepMatch[1], 10) === 0) return true;
      continue;
    }

    // Exact value
    if (parseInt(part, 10) === value) return true;
  }

  return false;
}

/** Human-readable description of a schedule */
export function describeSchedule(schedule: string): string {
  const lower = schedule.trim().toLowerCase();
  if (lower.startsWith("@")) return lower;

  const cron = resolveSchedule(schedule);
  const [min, hour, dom, mon, dow] = cron.split(/\s+/);

  if (dom === "*" && mon === "*" && dow === "*") {
    if (hour === "*") return `every hour at :${min.padStart(2, "0")}`;
    return `daily at ${hour}:${min.padStart(2, "0")}`;
  }
  if (dom === "*" && mon === "*" && dow === "1-5") {
    return `weekdays at ${hour}:${min.padStart(2, "0")}`;
  }
  if (dom === "*" && mon === "*" && dow === "1") {
    return `weekly on Monday at ${hour}:${min.padStart(2, "0")}`;
  }
  if (dom === "1" && mon === "*" && dow === "*") {
    return `monthly on the 1st at ${hour}:${min.padStart(2, "0")}`;
  }

  return `cron: ${cron}`;
}
