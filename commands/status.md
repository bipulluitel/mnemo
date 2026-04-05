---
name: status
description: Check Mnemo system health — daemon status, database stats,
  upcoming tasks, and message queue.
---

# System Status

Run these checks and report results:

1. Daemon running? `launchctl list | grep mnemo`
2. Database exists and accessible? Call `mnemo_profile` (category="_system")
3. Ollama running? `curl -s http://localhost:11434/api/tags`
4. DB stats: total profile facts, episodes, entities, sessions, scheduled tasks
5. Next scheduled task and when it runs
6. Pending messages count
7. Last profile build timestamp
8. Database file size and location
