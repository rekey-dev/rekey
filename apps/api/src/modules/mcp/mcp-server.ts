/**
 * MCP JSON-RPC handler for the hosted account-tools server.
 *
 * Implements the MCP methods a read-only tools server needs (initialize,
 * tools/list, tools/call, ping) as plain JSON-RPC 2.0 over HTTP, responding
 * with `application/json` — which the Streamable HTTP transport permits when
 * the client accepts it. Kept transport-agnostic + SDK-free so it's directly
 * unit-testable; the HTTP/auth layer lives in mcp.routes.ts.
 */

import { accountTools, type ToolContext } from './account-tools.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'relipay-account', version: '1.0.0' };

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function result(id: string | number | null, value: unknown): object {
  return { jsonrpc: '2.0', id, result: value };
}
function error(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle a single JSON-RPC message. Returns the response object, or `null` for
 * notifications (no `id`) which get no reply.
 */
export async function handleMcpMessage(
  ctx: ToolContext,
  msg: JsonRpcMessage,
): Promise<object | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  const id = (msg.id ?? null) as string | number | null;

  switch (msg.method) {
    case 'initialize':
      return result(id, {
        protocolVersion:
          typeof msg.params?.protocolVersion === 'string'
            ? (msg.params.protocolVersion as string)
            : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, {
        tools: accountTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = msg.params?.name;
      const tool = accountTools.find((t) => t.name === name);
      if (!tool) return error(id, -32602, `Unknown tool: ${String(name)}`);
      try {
        const data = await tool.handler(ctx);
        return result(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return error(id, -32601, `Method not found: ${String(msg.method)}`);
  }
}
