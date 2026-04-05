---
name: configure
description: Change Mnemo settings. Timezone, profile build interval,
  Telegram config, compression settings.
---

# Configure Mnemo

Read ~/.mnemo/config.json, show current settings, and let the user
change values. Write updated config back to disk.

After changing settings that affect the daemon (Telegram, timezone),
restart it:
```bash
launchctl kickstart -k gui/$(id -u)/com.mnemo.daemon
```
