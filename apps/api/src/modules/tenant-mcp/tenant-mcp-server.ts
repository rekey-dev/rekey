/**
 * Operator MCP JSON-RPC handler.
 *
 * Mirrors `modules/mcp/mcp-server.ts` (the per-Application end-user server)
 * but dispatches `operatorTools` keyed on (tenantUserId, tenantId) instead.
 * Kept transport-agnostic + SDK-free so the handlers are directly testable;
 * the HTTP/auth layer lives in `tenant-mcp.routes.ts`.
 */

import type { TenantRole } from '@prisma/client';
import { type Scope } from '../../lib/operator-scopes.js';
import { isWorkspaceAdmin } from '../../lib/access-context.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { effectiveToolScopes, operatorTools, type OperatorTool, type OperatorToolContext } from './operator-tools.js';
import { operatorWriteTools } from './operator-write-tools.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'rekey-operator', version: '1.0.0' };

/** All operator tools, read tools first, then the phase-1 write tools. */
const allTools: OperatorTool[] = [...operatorTools, ...operatorWriteTools];

/**
 * Scope each application-scoped tool needs. The REST twin of every tool
 * declares this on its route (`config.access`); tools declare it here, in one
 * table, and `route-access-completeness`'s MCP sibling asserts every tool
 * appears either here or in `WORKSPACE_TOOLS`, so a new tool cannot ship
 * ungoverned. Workspace-level tools are floors (role-gated), no scope needed.
 */
export const TOOL_SCOPES: Readonly<Record<string, Scope>> = {
  get_workspace_overview: 'overview:read',
  application_health: 'overview:read',
  recent_payments: 'billing:read',
  recent_subscriptions: 'billing:read',
  cancel_subscription: 'billing:write',
  configure_billing_provider: 'billing:write',
  list_plans: 'billing:read',
  create_plan: 'billing:write',
  update_plan: 'billing:write',
  set_plan_active: 'billing:write',
  register_plan_with_provider: 'billing:write',
  list_plan_entitlements: 'billing:read',
  put_plan_entitlement: 'billing:write',
  list_usage_meters: 'billing:read',
  create_usage_meter: 'billing:write',
  recent_security_events: 'activity:read',
  recent_webhook_events: 'developer:read',
  recent_failed_webhook_deliveries: 'developer:read',
  create_webhook_endpoint: 'developer:write',
  update_webhook_endpoint: 'developer:write',
  list_api_keys: 'developer:read',
  revoke_api_key: 'developer:write',
  mint_api_key: 'developer:write',
  get_end_user: 'end-users:read',
  list_devices: 'end-users:read',
  release_device: 'end-users:write',
  block_device: 'end-users:write',
  unblock_device: 'end-users:write',
  list_organization_roles: 'organizations:read',
  create_organization_role: 'organizations:write',
  update_organization_role: 'organizations:write',
  delete_organization_role: 'organizations:write',
  update_auth_config: 'auth-config:write',
};

/** Tools that are workspace-level floors: role-gated, scoped by nothing. */
export const WORKSPACE_TOOLS: ReadonlySet<string> = new Set([
  'list_applications',
  'list_members',
  'list_invitations',
  'invite_member',
  'revoke_invitation',
  'change_member_role',
  'remove_member',
  'create_application',
]);

/** OWNER > ADMIN > MEMBER. A higher rank clears a lower `minRole` threshold. */
const ROLE_RANK: Record<TenantRole, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1 } as Record<
  TenantRole,
  number
>;

function roleAllows(role: TenantRole, minRole: TenantRole): boolean {
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
}

/**
 * Can this caller use this tool? Single source of truth for both `tools/list`
 * (filter) and `tools/call` (gate), so the surfaced set and the callable set
 * can never drift apart.
 *
 *   - admin tools: admin scope AND role ≥ `minRole` (default ADMIN)
 *   - write tools: write scope AND role ≥ `minRole` (default ADMIN)
 *   - read tools:  role ≥ `minRole` when the tool declares one, else open
 *
 * That last line is the change. Read tools "are always available" was the rule,
 * and it silently overrode `minRole` on the two read tools whose REST twins are
 * OWNER/ADMIN, so a MEMBER could pull the workspace security log (every IP and
 * user agent in it) and the pending-invitation list out of MCP while the same
 * account got a 403 over HTTP. Per-Application grants are enforced inside the
 * handlers, since they depend on a tool's arguments; see
 * `accessibleApplicationIds` in operator-tools.ts.
 */
function toolAllowed(ctx: OperatorToolContext, tool: OperatorTool): boolean {
  // Scope gate first: a tool the caller's membership does not admit is
  // neither listed nor callable, whatever the token says. OWNER/ADMIN pass
  // unconditionally (see effectiveToolScopes), so this only bites a
  // restricted MEMBER.
  const held = effectiveToolScopes(ctx);
  const need = TOOL_SCOPES[tool.name];
  if (need !== undefined && !held.has(need)) return false;
  // Admin tools (destructive/financial/secret) need admin scope + role.
  if (tool.admin) return ctx.canAdmin && roleAllows(ctx.role, tool.minRole ?? 'ADMIN');
  // Write tools need write scope + role.
  if (tool.write) return ctx.canWrite && roleAllows(ctx.role, tool.minRole ?? 'ADMIN');
  // Read tools: no scope requirement, but an explicit `minRole` is honoured.
  return tool.minRole === undefined || roleAllows(ctx.role, tool.minRole);
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
      // Surface only the tools this token+role can actually call, a read-only
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
        } else if (TOOL_SCOPES[tool.name] !== undefined && !effectiveToolScopes(ctx).has(TOOL_SCOPES[tool.name]!)) {
          reason = `This tool requires the '${TOOL_SCOPES[tool.name]}' scope, which your membership does not hold. Ask a workspace owner or admin to extend your scopes.`;
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
      // Log the call before running it, whether or not the handler then
      // succeeds: a failed call is exactly what an operator reviewing an
      // agent's behaviour wants to see. A call refused above is not logged,
      // since nothing ran.
      //
      // Arguments are recorded by KEY only. They routinely carry credentials
      // (configure_billing_provider takes a provider secret), and an audit
      // trail that becomes a second copy of every secret is worse than none.
      // Names and shape are enough to answer "what did this agent do".
      void recordSecurityEvent({
        type: 'operator.mcp_tool_called',
        actorType: 'operator',
        actorId: ctx.tenantUserId,
        tenantId: ctx.tenantId,
        applicationId: typeof args.applicationId === 'string' ? args.applicationId : null,
        metadata: {
          tool: tool.name,
          write: tool.write === true,
          admin: tool.admin === true,
          // The scope that admitted the call: null for a workspace-floor
          // tool, and null for OWNER/ADMIN since no scope gate checked them.
          // Durable, unlike the request log: a membership's scopes can
          // change, and the audit trail must still say what authority a
          // past call ran under.
          scope: isWorkspaceAdmin(ctx.role) ? null : (TOOL_SCOPES[tool.name] ?? null),
          argKeys: Object.keys(args).sort(),
        },
      });

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
