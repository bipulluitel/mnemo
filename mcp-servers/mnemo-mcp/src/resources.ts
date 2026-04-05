import { getDb } from "./db.js";
import * as memRead from "./tools/memory-read.js";
import * as scheduling from "./tools/scheduling.js";
import * as messaging from "./tools/messaging.js";

export function listResources() {
  return [
    {
      uri: "mnemo://profile",
      name: "User Profile",
      description: "Full personality document",
      mimeType: "text/plain",
    },
    {
      uri: "mnemo://today",
      name: "Today's Context",
      description: "Tasks due, recent episodes, pending messages",
      mimeType: "application/json",
    },
    {
      uri: "mnemo://entities",
      name: "Key Entities",
      description: "People, projects, tools and their relationships",
      mimeType: "application/json",
    },
  ];
}

export function readResource(uri: string): { uri: string; mimeType: string; text: string } {
  switch (uri) {
    case "mnemo://profile": {
      const profile = memRead.getProfile();
      return {
        uri,
        mimeType: "text/plain",
        text: typeof profile === "string" ? profile : JSON.stringify(profile, null, 2),
      };
    }

    case "mnemo://today": {
      const today = new Date().toISOString().split("T")[0];
      const episodes = memRead.getEpisodes(5, today);
      const tasks = scheduling.listTasks(true);
      const messages = messaging.checkMessages();

      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            date: today,
            tasks_due: tasks.filter(
              (t) => t.next_run_at && t.next_run_at.startsWith(today)
            ),
            recent_episodes: episodes,
            pending_messages: messages,
          },
          null,
          2
        ),
      };
    }

    case "mnemo://entities": {
      const entities = memRead.searchEntities("*", undefined, 50);
      const db = getDb();
      const relations = db
        .prepare(
          `SELECT r.*, ea.name as name_a, eb.name as name_b
           FROM entity_relations r
           JOIN entities ea ON ea.id = r.entity_a
           JOIN entities eb ON eb.id = r.entity_b
           ORDER BY r.created_at DESC LIMIT 100`
        )
        .all();

      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ entities, relations }, null, 2),
      };
    }

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}
