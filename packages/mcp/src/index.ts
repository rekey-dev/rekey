#!/usr/bin/env node
/**
 * @rekey.dev/mcp — Model Context Protocol server.
 *
 * Speaks MCP over stdio, exposing introspection tools for Rekey
 * (Applications, Plans, Coupons, API keys, Tenants) plus a single guarded
 * WRITE tool (`mint_api_key`). Designed to be wired into Claude Desktop,
 * Cursor, and Claude Code so an AI agent can answer "what plans does this app
 * have?" or mint a fresh API key without screenshots.
 *
 * Read tools use `SUPER_ADMIN_KEY` (global scope). The write tool uses a SCOPED
 * operator personal-access-token (`REKEY_OPERATOR_TOKEN`, an `rp_op_…` token)
 * and is rejected server-side unless that PAT carries the `keys:mint` scope —
 * default-deny, so an agent can't mutate production unless explicitly granted.
 *
 * At least ONE credential is required. An agent that should only mint keys can
 * run with `REKEY_OPERATOR_TOKEN` alone (no master key) — read tools then fail
 * closed with `READ_REQUIRES_ADMIN_KEY`. Configure `SUPER_ADMIN_KEY` too to
 * enable the global read/introspection tools.
 */

import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from './lib/zod-to-json-schema.js';
import { AdminClient, AdminApiError } from './client.js';
import { tools } from './tools.js';
import { VERSION } from './version.js';

export { tools } from './tools.js';
export { AdminClient, AdminApiError } from './client.js';
export { VERSION } from './version.js';

/**
 * Build the MCP server from the environment, or return the reason it cannot be
 * built.
 *
 * ── Why this is a function, and why nothing runs at module scope ──
 *
 * This package declares `main` / `types` / `exports` like a library, so
 * `import '@rekey.dev/mcp'` is a thing people can do — a test harness listing
 * the tools, a wrapper re-exporting them. It used to read the env and call
 * `process.exit(1)` while the module was still evaluating, which killed the
 * HOST process on a plain import. An importer cannot catch that; there is no
 * try/catch around a module's side effects.
 *
 * So the env check moved behind the entry point (see the bottom of this file).
 * Importing is now inert; only running the `rekey-mcp` bin exits.
 */
export function createServer(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; server: Server }
  | { ok: false; message: string } {
  const apiUrl = env.REKEY_URL ?? '';
  const adminKey = env.SUPER_ADMIN_KEY ?? '';
  // Optional: only required by the `mint_api_key` write tool. Read tools work
  // without it. When absent, the write tool fails closed with a clear error.
  const operatorToken = env.REKEY_OPERATOR_TOKEN ?? '';

  if (!apiUrl || (!adminKey && !operatorToken)) {
    return {
      ok: false,
      message:
        `[rekey-mcp] missing required env: REKEY_URL plus at least one credential ` +
        `(SUPER_ADMIN_KEY for read tools and/or REKEY_OPERATOR_TOKEN for the keys:mint write tool).\n` +
        `[rekey-mcp] fix: configure these in the MCP client (Claude Desktop config, Cursor MCP settings, …)\n`,
    };
  }

  const client = new AdminClient({
    apiUrl,
    ...(adminKey ? { adminKey } : {}),
    ...(operatorToken ? { operatorToken } : {}),
  });

  const server = new Server(
    { name: 'rekey-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: 'TOOL_NOT_FOUND',
                message: `Unknown tool: ${req.params.name}`,
                fix: 'Call list_tools to see what is available.',
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: 'TOOL_ARGS_INVALID',
                message: 'Tool arguments failed validation.',
                fix: 'Re-call with arguments matching inputSchema. Issues: ' +
                  parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await tool.execute(client, parsed.data);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (err instanceof AdminApiError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: { code: err.code, message: err.message, fix: err.fix, statusCode: err.statusCode },
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: {
                code: 'TOOL_EXECUTION_FAILED',
                message: err instanceof Error ? err.message : String(err),
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  });

  return { ok: true, server };
}

/** Start the stdio server, or exit(1) with the reason. Called only by the bin. */
export async function main(): Promise<void> {
  const built = createServer();
  if (!built.ok) {
    process.stderr.write(built.message);
    process.exit(1);
  }
  await built.server.connect(new StdioServerTransport());
}

// Run ONLY when this file is the process entry point (`rekey-mcp`, or
// `node dist/index.js`). `import '@rekey.dev/mcp'` from another program takes
// neither branch and has no side effects.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
