/**
 * Operator MCP JSON-RPC handler.
 *
 * Mirrors `modules/mcp/mcp-server.ts` (the per-Application end-user server)
 * but dispatches `operatorTools` keyed on (tenantUserId, tenantId) instead.
 * Kept transport-agnostic + SDK-free so the handlers are directly testable;
 * the HTTP/auth layer lives in `tenant-mcp.routes.ts`.
 */

import type { TenantRole } from '@prisma/client';
import { operatorTools, type OperatorTool, type OperatorToolContext } from './operator-tools.js';
import { operatorWriteTools } from './operator-write-tools.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'relipay-operator', version: '1.0.0' };

/** All operator tools — read tools first, then the phase-1 write tools. */
const allTools: OperatorTool[] = [...operatorTools, ...operatorWriteTools];

/** OWNER > ADMIN > MEMBER. A higher rank clears a lower `minRole` threshold. */
const ROLE_RANK: Record<TenantRole, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1 } as Record<
  TenantRole,
  number
>;

function roleAllows(role: TenantRole, minRole: TenantRole): boolean {
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
}

/**
 * Can this caller use this tool? Read tools are always available; write tools
 * require the token to carry write scope AND the operator's role to clear the
 * tool's `minRole` (default ADMIN). Single source of truth for both
 * `tools/list` (filter) and `tools/call` (gate) so the surfaced set and the
 * callable set can never drift apart.
 */
function toolAllowed(ctx: OperatorToolContext, tool: OperatorTool): boolean {
  // Admin tools (destructive/financial/secret) need admin scope + role.
  if (tool.admin) return ctx.canAdmin && roleAllows(ctx.role, tool.minRole ?? 'ADMIN');
  // Write tools need write scope + role.
  if (tool.write) return ctx.canWrite && roleAllows(ctx.role, tool.minRole ?? 'ADMIN');
  // Read tools are always available.
  return true;
}

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
      // Surface only the tools this token+role can actually call — a read-only
      // token never sees the write tools, so the client won't offer them.
      return result(id, {
        tools: allTools
          .filter((t) => toolAllowed(ctx, t))
          .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
      });

    case 'tools/call': {
      const name = msg.params?.name;
      const tool = allTools.find((t) => t.name === name);
      if (!tool) return error(id, -32602, `Unknown tool: ${String(name)}`);
      // Re-gate at call time. A client that calls a write tool without write
      // scope (or with an insufficient role) gets an explicit, non-leaky
      // refusal rather than the tool silently running.
      if (!toolAllowed(ctx, tool)) {
        let reason: string;
        if (tool.admin && !ctx.canAdmin) {
          reason =
            'This tool requires admin access (destructive/financial). Re-authorize the connector with the "mcp:operator:admin" scope.';
        } else if (tool.write && !ctx.canWrite) {
          reason =
            'This tool requires write access. Re-authorize the connector with the "mcp:operator:write" scope (or use a PAT with the "applications:write" scope).';
        } else {
          reason = `This tool requires at least the ${tool.minRole ?? 'ADMIN'} role in this workspace.`;
        }
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: reason }) }],
          isError: true,
        });
      }
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
