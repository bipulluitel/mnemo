/**
 * MCP Prompts with token-budgeted session startup.
 *
 * Context budget (~4000 tokens target):
 *   Priority 1 (always):  Profile document + date/time     ~1500 tokens
 *   Priority 2 (always):  Pending messages + tasks due      ~500 tokens
 *   Priority 3 (recent):  Last 3 session summaries          ~1000 tokens
 *   Priority 4 (recent):  Last 5 episodes                   ~800 tokens
 *   Priority 5 (on-demand): mnemo_recall for topic context  variable
 *
 * Rough token estimate: 1 token ≈ 4 characters
 */

import * as memRead from "./tools/memory-read.js";
import * as scheduling from "./tools/scheduling.js";
import * as messaging from "./tools/messaging.js";

const CHARS_PER_TOKEN = 4;
const MAX_BUDGET_TOKENS = 4500;
const MAX_BUDGET_CHARS = MAX_BUDGET_TOKENS * CHARS_PER_TOKEN;

export function listPrompts() {
  return [
    {
      name: "mnemo_session_start",
      description:
        "Load context at the beginning of a session: profile, recent episodes, messages, tasks. Token-budgeted to ~4000 tokens.",
    },
    {
      name: "mnemo_session_end",
      description:
        "Prompt to save session summary, decisions, and facts learned",
    },
  ];
}

export function getPrompt(name: string) {
  switch (name) {
    case "mnemo_session_start":
      return buildSessionStartPrompt();

    case "mnemo_session_end":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `This session is ending. Please:
1. Call mnemo_save_session with a summary of what we discussed, key decisions made, and new facts you learned about me.
2. Call mnemo_remember for any new facts about me that came up.
3. Call mnemo_record_episode for any notable decisions or events.`,
            },
          },
        ],
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}

function buildSessionStartPrompt() {
  const sections: Array<{ priority: number; label: string; content: string }> = [];
  let usedChars = 0;

  // ── Priority 1: Profile document + timestamp ──
  const profile = memRead.getProfile();
  const now = new Date();
  const timestamp = `Current date/time: ${now.toISOString()} (${Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    timeZoneName: "short",
  }).format(now)})`;

  const profileText =
    typeof profile === "string"
      ? profile
      : profile.length > 0
        ? profile
            .map((f) => `- [${f.category}] ${f.key}: ${f.value}`)
            .join("\n")
        : "No profile yet — learn about this user and build their profile.";

  const p1 = `${timestamp}\n\n# Who You're Talking To\n\n${profileText}`;
  sections.push({ priority: 1, label: "profile", content: p1 });
  usedChars += p1.length;

  // ── Priority 2: Pending messages + tasks due today ──
  const messages = messaging.checkMessages();
  const tasks = scheduling.listTasks(true);
  const dueTasks = tasks.filter((t) => {
    if (!t.next_run_at) return false;
    return new Date(t.next_run_at) <= now;
  });
  const upcomingTasks = tasks
    .filter((t) => {
      if (!t.next_run_at) return false;
      const next = new Date(t.next_run_at);
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return next > now && next <= tomorrow;
    })
    .slice(0, 5);

  const p2Parts: string[] = [];
  if (messages.length > 0) {
    p2Parts.push(
      `# Pending Messages\n\n${messages
        .map((m) => `- [${m.channel}] ${m.content}`)
        .join("\n")}`
    );
  }
  if (dueTasks.length > 0) {
    p2Parts.push(
      `# Tasks Due Now\n\n${dueTasks
        .map((t) => `- **${t.name}**: ${t.description}`)
        .join("\n")}`
    );
  }
  if (upcomingTasks.length > 0) {
    p2Parts.push(
      `# Upcoming Tasks (next 24h)\n\n${upcomingTasks
        .map((t) => `- ${t.name} — ${t.next_run_at}`)
        .join("\n")}`
    );
  }

  if (p2Parts.length > 0) {
    const p2 = p2Parts.join("\n\n");
    sections.push({ priority: 2, label: "messages+tasks", content: p2 });
    usedChars += p2.length;
  }

  // ── Priority 3: Recent session summaries ──
  const remaining3 = MAX_BUDGET_CHARS - usedChars;
  if (remaining3 > 500) {
    const sessions = memRead.getSessions(3);
    if (sessions.length > 0) {
      let p3 = `# Recent Sessions\n\n${sessions
        .map(
          (s) =>
            `- **${s.started_at || "unknown"}**: ${s.summary || "(no summary)"}`
        )
        .join("\n")}`;

      // Trim if needed
      if (p3.length > remaining3) {
        p3 = p3.slice(0, remaining3 - 3) + "...";
      }

      sections.push({ priority: 3, label: "sessions", content: p3 });
      usedChars += p3.length;
    }
  }

  // ── Priority 4: Recent episodes ──
  const remaining4 = MAX_BUDGET_CHARS - usedChars;
  if (remaining4 > 400) {
    const episodes = memRead.getEpisodes(5);
    if (episodes.length > 0) {
      let p4 = `# Recent Events\n\n${episodes
        .map((e) => `- ${e.created_at}: ${e.summary}`)
        .join("\n")}`;

      if (p4.length > remaining4) {
        p4 = p4.slice(0, remaining4 - 3) + "...";
      }

      sections.push({ priority: 4, label: "episodes", content: p4 });
      usedChars += p4.length;
    }
  }

  // Assemble
  const fullText = sections.map((s) => s.content).join("\n\n");
  const estimatedTokens = Math.ceil(fullText.length / CHARS_PER_TOKEN);

  return {
    description: `Session context (${estimatedTokens} estimated tokens, ${sections.length} sections)`,
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: fullText,
        },
      },
    ],
  };
}
