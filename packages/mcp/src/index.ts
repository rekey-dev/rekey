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
 * operator personal-access-token (`RELIPAY_OPERATOR_TOKEN`, an `rp_op_…` token)
 * and is rejected server-side unless that PAT carries the `keys:mint` scope —
 * default-deny, so an agent can't mutate production unless explicitly granted.
 *
 * At least ONE credential is required. An agent that should only mint keys can
 * run with `RELIPAY_OPERATOR_TOKEN` alone (no master key) — read tools then fail
 * closed with `READ_REQUIRES_ADMIN_KEY`. Configure `SUPER_ADMIN_KEY` too to
 * enable the global read/introspection tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from './lib/zod-to-json-schema.js';
import { AdminClient, AdminApiError } from './client.js';
import { tools } from './tools.js';

const apiUrl = process.env.RELIPAY_URL ?? '';
const adminKey = process.env.SUPER_ADMIN_KEY ?? '';
// Optional: only required by the `mint_api_key` write tool. Read tools work
// without it. When absent, the write tool fails closed with a clear error.
const operatorToken = process.env.RELIPAY_OPERATOR_TOKEN ?? '';

if (!apiUrl || (!adminKey && !operatorToken)) {
  process.stderr.write(
    `[rekey-mcp] missing required env: RELIPAY_URL plus at least one credential ` +
      `(SUPER_ADMIN_KEY for read tools and/or RELIPAY_OPERATOR_TOKEN for the keys:mint write tool).\n` +
      `[rekey-mcp] fix: configure these in the MCP client (Claude Desktop config, Cursor MCP settings, …)\n`,
  );
  process.exit(1);
}

const client = new AdminClient({
  apiUrl,
  ...(adminKey ? { adminKey } : {}),
  ...(operatorToken ? { operatorToken } : {}),
});

const server = new Server(
  { name: 'rekey-mcp', version: '0.0.0' },
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

const transport = new StdioServerTransport();
void server.connect(transport);
