/**
 * Operator MCP JSON-RPC handler.
 *
 * Mirrors `modules/mcp/mcp-server.ts` (the per-Application end-user server)
 * but dispatches `operatorTools` keyed on (tenantUserId, tenantId) instead.
 * Kept transport-agnostic + SDK-free so the handlers are directly testable;
 * the HTTP/auth layer lives in `tenant-mcp.routes.ts`.
 */

import { operatorTools, type OperatorToolContext } from './operator-tools.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'relipay-operator', version: '1.0.0' };

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
export async function handleOperatorMcpMessage(
  ctx: OperatorToolContext,
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
        tools: operatorTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = msg.params?.name;
      const tool = operatorTools.find((t) => t.name === name);
      if (!tool) return error(id, -32602, `Unknown tool: ${String(name)}`);
      const args =
        (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
      try {
        const data = await tool.handler(ctx, args);
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
