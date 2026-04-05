import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { runSetup, SetupResult } from "./installer.js";
import { getStatus } from "./status.js";

const server = new Server(
  { name: "mnemo-stub", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "setup_mnemo",
      description:
        "Install and configure the Mnemo persistent memory system. Clones the repository, compiles native dependencies for the current Node runtime, initializes the database, and installs the background daemon. Run this once — subsequent calls update the installation. After setup completes, restart Claude Desktop to activate all Mnemo tools.",
      inputSchema: {
        type: "object" as const,
        properties: {
          force: {
            type: "boolean",
            description:
              "Force reinstall even if already set up (pulls latest code and rebuilds)",
          },
          repo_url: {
            type: "string",
            description:
              "Git repository URL (default: https://github.com/bipulluitel/mnemo.git)",
          },
          skip_daemon: {
            type: "boolean",
            description: "Skip daemon installation (MCP server only)",
          },
        },
      },
    },
    {
      name: "mnemo_status",
      description:
        "Check the Mnemo installation status: whether the full server is installed, the database exists, the daemon is running, etc.",
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
    switch (name) {
      case "setup_mnemo": {
        const result: SetupResult = await runSetup({
          force: (args?.force as boolean) ?? false,
          repoUrl: args?.repo_url as string | undefined,
          skipDaemon: (args?.skip_daemon as boolean) ?? false,
        });
        return {
          content: [{ type: "text" as const, text: result.report }],
          isError: !result.success,
        };
      }
      case "mnemo_status": {
        const status = await getStatus();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }
      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start mnemo-stub:", err);
  process.exit(1);
});
