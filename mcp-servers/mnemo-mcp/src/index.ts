import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { closeDb, getConfig } from "./db.js";
import { getSyncStatus, checkpointWal } from "@mnemo/shared";
import * as memRead from "./tools/memory-read.js";
import * as memWrite from "./tools/memory-write.js";
import * as session from "./tools/session.js";
import * as scheduling from "./tools/scheduling.js";
import * as messaging from "./tools/messaging.js";
import * as system from "./tools/system.js";
import { listResources, readResource } from "./resources.js";
import { listPrompts, getPrompt } from "./prompts.js";

const server = new Server(
  { name: "mnemo-mcp", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// ═══════════════════════════════════════════════
// TOOLS
// ═══════════════════════════════════════════════

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Read ──
    {
      name: "mnemo_recall",
      description:
        "Search memory across all tables (profile, episodes, conversations, entities) using full-text search. Returns ranked results.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "mnemo_profile",
      description:
        "Get the user's personality profile. No category = full synthesized document. With category = facts in that category.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            description: "Filter by category (identity, preferences, work, etc.)",
          },
        },
      },
    },
    {
      name: "mnemo_episodes",
      description: "Get recent notable events and decisions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Max results (default 10)" },
          since: { type: "string", description: "ISO date to filter from" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags",
          },
        },
      },
    },
    {
      name: "mnemo_sessions",
      description: "Get past session summaries.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Max results (default 5)" },
          since: { type: "string", description: "ISO date to filter from" },
        },
      },
    },
    {
      name: "mnemo_entity",
      description:
        "Get entity details and all relationships. Fuzzy name matching.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Entity name" },
        },
        required: ["name"],
      },
    },
    {
      name: "mnemo_search_entities",
      description: 'FTS search across entities. Use query "*" for all.',
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          type: {
            type: "string",
            description: "Filter by entity type (person, project, tool, etc.)",
          },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "mnemo_profile_history",
      description:
        "View profile build history — see how the personality document has evolved over time.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Max builds to return (default 5)" },
          version: { type: "number", description: "Get a specific build version" },
        },
      },
    },
    // ── Write ──
    {
      name: "mnemo_remember",
      description:
        "Store or update a profile fact. Upserts by category+key. Old values are preserved in history.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            description:
              "Fact category: identity, preferences, work, communication, technical, opinions, _system",
          },
          key: { type: "string", description: "Fact key (e.g., 'name', 'favorite_language')" },
          value: { type: "string", description: "Fact value" },
          confidence: {
            type: "number",
            description: "0.0–1.0, how confident (default 0.5)",
          },
          source: {
            type: "string",
            enum: ["explicit", "inferred", "observed"],
            description: "How this was learned (default 'inferred')",
          },
        },
        required: ["category", "key", "value"],
      },
    },
    {
      name: "mnemo_record_episode",
      description:
        "Record a notable event, decision, or occurrence. Episodes are timestamped and searchable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          summary: { type: "string", description: "Brief summary of what happened" },
          details: { type: "string", description: "Extended details" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for categorization",
          },
          importance: {
            type: "number",
            description: "0.0–1.0, how important (default 0.5)",
          },
        },
        required: ["summary"],
      },
    },
    {
      name: "mnemo_track_entity",
      description:
        "Create or update an entity (person, project, tool, company, etc.). Merges attributes on update.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Entity name" },
          type: {
            type: "string",
            description: "Entity type: person, project, tool, company, concept, etc.",
          },
          attributes: {
            type: "object",
            description: "Key-value attributes (role, url, status, etc.)",
          },
        },
        required: ["name", "type"],
      },
    },
    {
      name: "mnemo_relate",
      description:
        "Create a relationship between two entities. Creates entities if they don't exist.",
      inputSchema: {
        type: "object" as const,
        properties: {
          entity_a: { type: "string", description: "First entity name" },
          entity_b: { type: "string", description: "Second entity name" },
          relation: {
            type: "string",
            description:
              "Relationship type: works_on, manages, uses, knows, created, member_of, etc.",
          },
          context: { type: "string", description: "Additional context about the relationship" },
        },
        required: ["entity_a", "entity_b", "relation"],
      },
    },
    {
      name: "mnemo_forget",
      description:
        "Search for memories to delete. Returns matches first — call again with confirm=true to delete.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "What to forget" },
          confirm: {
            type: "boolean",
            description: "Set to true to actually delete the matches",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "mnemo_save_session",
      description:
        "Save session summary at session end. Records key decisions and facts learned.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Unique session identifier" },
          summary: { type: "string", description: "Session summary" },
          key_decisions: {
            type: "array",
            items: { type: "string" },
            description: "Important decisions made",
          },
          key_facts: {
            type: "array",
            items: { type: "string" },
            description: "New facts learned about the user",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Topic tags",
          },
        },
        required: ["session_id", "summary"],
      },
    },
    // ── Scheduling ──
    {
      name: "mnemo_schedule",
      description:
        "Create a scheduled task. Supports cron expressions and aliases: @hourly, @daily [HH:MM], @weekdays [HH:MM], @weekly, @monthly",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Short task name" },
          description: {
            type: "string",
            description: "Full prompt/instructions for Claude to execute",
          },
          schedule: {
            type: "string",
            description: "Cron expression or alias (@daily, @weekdays 9:00, etc.)",
          },
          timezone: { type: "string", description: "IANA timezone (default UTC)" },
          requires_confirmation: {
            type: "boolean",
            description: "Ask before running (default false)",
          },
        },
        required: ["name", "description", "schedule"],
      },
    },
    {
      name: "mnemo_list_tasks",
      description: "List all scheduled tasks with next run times.",
      inputSchema: {
        type: "object" as const,
        properties: {
          enabled_only: { type: "boolean", description: "Only show enabled tasks" },
        },
      },
    },
    {
      name: "mnemo_update_task",
      description: "Update a scheduled task's fields.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "number", description: "Task ID" },
          fields: {
            type: "object",
            description: "Fields to update: name, description, schedule, timezone, enabled, requires_confirmation",
          },
        },
        required: ["id", "fields"],
      },
    },
    {
      name: "mnemo_delete_task",
      description: "Delete a scheduled task.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "number", description: "Task ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "mnemo_task_history",
      description: "Get execution log for a scheduled task.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "number", description: "Task ID" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["task_id"],
      },
    },
    // ── Messaging ──
    {
      name: "mnemo_send_message",
      description:
        "Send a message to the user via Telegram (or other configured channel). Queued for daemon delivery.",
      inputSchema: {
        type: "object" as const,
        properties: {
          content: { type: "string", description: "Message content" },
          channel: { type: "string", description: "Channel (default 'telegram')" },
        },
        required: ["content"],
      },
    },
    {
      name: "mnemo_check_messages",
      description: "Check for pending inbound messages from the user.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: "Filter by channel" },
        },
      },
    },
    // ── System ──
    {
      name: "mnemo_sync_status",
      description:
        "Check database sync status: file health, WAL size, sync provider, conflict detection.",
      inputSchema: {
        type: "object" as const,
        properties: {
          checkpoint: {
            type: "boolean",
            description: "Run a WAL checkpoint to merge writes into main DB (useful before sync)",
          },
        },
      },
    },
    {
      name: "mnemo_configure",
      description:
        "Read or update Mnemo configuration. Call with no fields to read current config. Provide fields to update.",
      inputSchema: {
        type: "object" as const,
        properties: {
          updates: {
            type: "object",
            description:
              "Fields to update: timezone, profile_build_interval, compression_keep_full_days, compression_keep_summary_days, log_level, telegram (object with enabled, bot_token, user_id)",
          },
        },
      },
    },
    {
      name: "mnemo_system_stats",
      description:
        "Get comprehensive system stats: database counts, sync health, Ollama status, vector search availability, and configuration.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      // Read
      case "mnemo_recall":
        result = await memRead.recall(args!.query as string, args?.limit as number);
        break;
      case "mnemo_profile":
        result = memRead.getProfile(args?.category as string);
        break;
      case "mnemo_episodes":
        result = memRead.getEpisodes(
          args?.limit as number,
          args?.since as string,
          args?.tags as string[]
        );
        break;
      case "mnemo_sessions":
        result = memRead.getSessions(args?.limit as number, args?.since as string);
        break;
      case "mnemo_entity":
        result = memRead.getEntity(args!.name as string);
        break;
      case "mnemo_search_entities":
        result = memRead.searchEntities(
          args!.query as string,
          args?.type as string,
          args?.limit as number
        );
        break;
      case "mnemo_profile_history":
        if (args?.version) {
          result = memRead.getProfileBuild(args.version as number);
        } else {
          result = memRead.getProfileHistory(args?.limit as number);
        }
        break;

      // Write
      case "mnemo_remember":
        result = memWrite.remember(
          args!.category as string,
          args!.key as string,
          args!.value as string,
          args?.confidence as number,
          args?.source as string
        );
        break;
      case "mnemo_record_episode":
        result = memWrite.recordEpisode(
          args!.summary as string,
          args?.details as string,
          args?.tags as string[],
          args?.importance as number
        );
        break;
      case "mnemo_track_entity":
        result = memWrite.trackEntity(
          args!.name as string,
          args!.type as string,
          args?.attributes as Record<string, unknown>
        );
        break;
      case "mnemo_relate":
        result = memWrite.relate(
          args!.entity_a as string,
          args!.entity_b as string,
          args!.relation as string,
          args?.context as string
        );
        break;
      case "mnemo_forget":
        result = memWrite.forget(args!.query as string, args?.confirm as boolean);
        break;
      case "mnemo_save_session":
        result = session.saveSession(
          args!.session_id as string,
          args!.summary as string,
          args?.key_decisions as string[],
          args?.key_facts as string[],
          args?.tags as string[]
        );
        break;

      // Scheduling
      case "mnemo_schedule":
        result = scheduling.schedule(
          args!.name as string,
          args!.description as string,
          args!.schedule as string,
          args?.timezone as string,
          args?.requires_confirmation as boolean
        );
        break;
      case "mnemo_list_tasks":
        result = scheduling.listTasks(args?.enabled_only as boolean);
        break;
      case "mnemo_update_task":
        result = scheduling.updateTask(args!.id as number, args!.fields as Record<string, unknown>);
        break;
      case "mnemo_delete_task":
        result = scheduling.deleteTask(args!.id as number);
        break;
      case "mnemo_task_history":
        result = scheduling.taskHistory(args!.task_id as number, args?.limit as number);
        break;

      // Messaging
      case "mnemo_send_message":
        result = messaging.sendMessage(args!.content as string, args?.channel as string);
        break;
      case "mnemo_check_messages":
        result = messaging.checkMessages(args?.channel as string);
        break;

      // System
      case "mnemo_sync_status": {
        const cfg = getConfig();
        const status = getSyncStatus(cfg.db_path);
        if (args?.checkpoint) {
          const cp = checkpointWal(cfg.db_path);
          result = { ...status, checkpoint: cp };
        } else {
          result = status;
        }
        break;
      }
      case "mnemo_configure":
        if (args?.updates) {
          result = system.updateConfiguration(args.updates as Partial<import("@mnemo/shared").MnemoConfig>);
        } else {
          result = system.getConfiguration();
        }
        break;
      case "mnemo_system_stats":
        result = await system.getSystemStats();
        break;

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// ═══════════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════════

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: listResources(),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [readResource(request.params.uri)],
}));

// ═══════════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════════

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: listPrompts(),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  return getPrompt(request.params.name);
});

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", () => {
    closeDb();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    closeDb();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start mnemo-mcp:", err);
  process.exit(1);
});
