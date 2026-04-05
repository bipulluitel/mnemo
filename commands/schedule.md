---
name: schedule
description: "Create a scheduled task from natural language. Example: /mnemo:schedule check my email every morning at 8am"
---

# Create Scheduled Task

Parse the user's natural language instruction into a scheduled task.

1. Extract:
   - Task name (short, descriptive)
   - Task description (the full prompt Claude will execute)
   - Schedule (convert to cron or alias)
   - Whether it needs confirmation before running

2. Supported aliases: @hourly, @daily, @daily HH:MM, @weekdays,
   @weekdays HH:MM, @weekly, @monthly, or raw cron (5-field)

3. Call `mnemo_schedule` with the parsed fields

4. Confirm with the user: "Scheduled '[name]' to run [schedule description].
   Next run: [calculated time]."
