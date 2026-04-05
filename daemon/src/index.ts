import {
  loadConfig,
  openDatabase,
  Logger,
  Embedder,
  checkpointWal,
} from "@mnemo/shared";
import { SessionWatcher } from "./session-watcher.js";
import { ProfileTrigger } from "./profile-trigger.js";
import { TaskRunner } from "./task-runner.js";
import { TelegramBot } from "./telegram-bot.js";
import { MessageBridge } from "./message-bridge.js";
import { Compressor } from "./compressor.js";

let running = true;

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.log_level || "info", config.log_file);

  logger.info("Mnemo daemon starting", { db: config.db_path });

  const db = openDatabase(config.db_path);
  const embedder = new Embedder(config.ollama_url, config.ollama_model);

  // Initialize core services
  const sessionWatcher = new SessionWatcher(
    db,
    embedder,
    logger,
    config.cowork_data_dir
  );

  const profileTrigger = new ProfileTrigger(
    db,
    logger,
    config.profile_build_interval
  );

  const taskRunner = new TaskRunner(db, logger);

  // Initialize Telegram bot (optional)
  let telegramBot: TelegramBot | null = null;
  if (config.telegram.enabled && config.telegram.bot_token && config.telegram.user_id) {
    try {
      telegramBot = new TelegramBot(
        config.telegram.bot_token,
        config.telegram.user_id,
        db,
        logger,
        profileTrigger
      );
      await telegramBot.start();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to start Telegram bot: ${msg}`);
      telegramBot = null;
    }
  } else {
    logger.info("Telegram not configured — message bridge will queue only");
  }

  // Initialize message bridge
  const messageBridge = new MessageBridge(db, logger, telegramBot);

  const compressor = new Compressor(
    db,
    logger,
    config.compression_keep_full_days,
    config.compression_keep_summary_days
  );

  // Register shutdown handlers
  const shutdown = async () => {
    running = false;
    logger.info("Shutting down...");
    if (telegramBot) {
      await telegramBot.stop().catch(() => {});
    }
    // Final WAL checkpoint before exit
    try {
      checkpointWal(config.db_path);
    } catch {
      // ignore
    }
    db.close();
    logger.info("Mnemo daemon stopped");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const services = [
    "session-watcher",
    "profile-trigger",
    "task-runner",
    "message-bridge",
    "compressor",
  ];
  if (telegramBot) services.push("telegram-bot");
  logger.info(`Mnemo daemon running. Active services: ${services.join(", ")}`);

  // Tick loop — 30 second intervals
  let tickCount = 0;
  while (running) {
    await sleep(30_000);
    if (!running) break;
    tickCount++;

    // Session watcher: every tick (30s)
    try {
      await sessionWatcher.tick();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Session watcher tick failed: ${msg}`);
    }

    // Profile trigger: every tick (internally throttled to 60s)
    try {
      profileTrigger.tick();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Profile trigger tick failed: ${msg}`);
    }

    // Task runner: every tick (internally throttled to 60s)
    try {
      await taskRunner.tick();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Task runner tick failed: ${msg}`);
    }

    // Message bridge: every tick (internally throttled to 15s)
    try {
      await messageBridge.tick();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Message bridge tick failed: ${msg}`);
    }

    // WAL checkpoint: every 5 minutes (10 ticks) for sync safety
    if (tickCount % 10 === 0) {
      try {
        const cp = checkpointWal(config.db_path);
        if (cp.walPages > 0) {
          logger.debug(`WAL checkpoint: ${cp.checkpointed}/${cp.walPages} pages`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`WAL checkpoint failed: ${msg}`);
      }
    }

    // Compressor: every tick (only runs at 3am, once per day)
    try {
      compressor.tick();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Compressor tick failed: ${msg}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

main().catch((err) => {
  console.error("Daemon crashed:", err);
  process.exit(1);
});
