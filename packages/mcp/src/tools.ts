/**
 * MCP tool registry. Each tool is a `(client, args) → result` function with
 * a Zod-described input schema. The server (index.ts) wires them up.
 *
 * Read tools authenticate with the admin key. The one WRITE tool
 * (`mint_api_key`) authenticates instead with a SCOPED operator
 * personal-access-token (`REKEY_OPERATOR_TOKEN`) and is rejected server-side
 * unless that PAT carries the `keys:mint` scope — default-deny, so an agent
 * can't mint production keys unless explicitly granted. See AGENTS.md.
 */

import { z } from 'zod';
import type { AdminClient } from './client.js';

export interface ToolDefinition<TArgs extends z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<TArgs>;
  execute: (client: AdminClient, args: z.infer<z.ZodObject<TArgs>>) => Promise<unknown>;
}

/**
 * `limit` / `offset` — accepted by every list endpoint on the admin surface.
 *
 * Merged into each list tool's args so a model can page. Before 2.0.0-rc.3
 * these endpoints returned a bare array with no `total`, so a tool result
 * silently capped at the server default was indistinguishable from a complete
 * one; a model reading "3 applications" had no way to know there were 90.
 */
const PagingArgs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Rows per page, 1-100. Default 50.'),
  offset: z.number().int().min(0).optional().describe('Rows to skip (0-based). Default 0.'),
};

/** Build `?a=b&…`, dropping undefined values. Returns '' when empty. */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

const ListApplicationsArgs = z.object({
  tenantId: z.string().optional().describe('Optional Tenant id to filter by.'),
  ...PagingArgs,
});

const GetApplicationArgs = z.object({
  applicationId: z.string().describe('Application id (cuid).'),
});

const ListPlansArgs = z.object({
  applicationId: z.string().describe('Application id to list plans for.'),
  includeInactive: z.boolean().optional().describe('If true, include deactivated plans.'),
  ...PagingArgs,
});

const ListCouponsArgs = z.object({
  applicationId: z.string().describe('Application id to list coupons for.'),
  includeInactive: z.boolean().optional(),
  ...PagingArgs,
});

const ListApiKeysArgs = z.object({
  applicationId: z.string().describe('Application id to list active API keys for.'),
});

const MintApiKeyArgs = z.object({
  applicationId: z
    .string()
    .describe('Application id to mint a secret key for. Must belong to the operator PAT\'s workspace.'),
  name: z
    .string()
    .describe('Human label for the key, shown in lists (e.g. "ci-deploy", "agent-worker").'),
  scopes: z
    .array(z.string())
    .optional()
    .describe('Application-key scopes (e.g. ["auth:read"]). Omit for the default ["*"].'),
});

const ListTenantsArgs = z.object({ ...PagingArgs });

const ListPaymentsArgs = z.object({
  applicationId: z.string().optional().describe('Filter to one Application id.'),
  status: z
    .enum(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'])
    .optional()
    .describe('Filter by payment status.'),
  q: z
    .string()
    .optional()
    .describe('Exact-match search: payment id, provider payment id, or end-user id.'),
  sort: z.enum(['createdAt', 'amount']).optional().describe('Sort field. Default createdAt.'),
  order: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default desc.'),
  limit: z.number().int().min(1).max(200).optional().describe('Page size, 1–200. Default 50.'),
});

const PaymentStatsByAppArgs = z.object({});

export const tools: Array<ToolDefinition<z.ZodRawShape>> = [
  {
    name: 'list_tenants',
    description:
      'List Tenants. Tenants are the outer multi-tenancy unit (one per Rekey customer). Use this when the user asks "what tenants exist" or to find a tenantId to drill into. ' +
      'Returns `{items, page}` — check `page.hasMore` / `page.total` before concluding you have seen them all, and pass `offset` for the next window.',
    inputSchema: ListTenantsArgs,
    execute: (c, args) => c.request('GET', `/api/v1/admin/tenants${query(args)}`),
  },
  {
    name: 'list_applications',
    description:
      'List Applications, optionally filtered by Tenant. An Application is one project under a Tenant; every domain row in Rekey carries an applicationId. Use this to find the applicationId for subsequent calls. ' +
      'Returns `{items, page}` — check `page.hasMore` / `page.total` before concluding you have seen them all.',
    inputSchema: ListApplicationsArgs,
    execute: (c, args) => c.request('GET', `/api/v1/admin/applications${query(args)}`),
  },
  {
    name: 'get_application',
    description:
      'Fetch one Application by id, including its authConfig and billingConfig (no secrets).',
    inputSchema: GetApplicationArgs,
    execute: (c, args) =>
      c.request('GET', `/api/v1/admin/applications/${encodeURIComponent(args.applicationId)}`),
  },
  {
    name: 'list_plans',
    description:
      'List Plans for an Application. Amount is always in the smallest currency unit (cents/paise/sen) — never floats. ' +
      'Returns `{items, page}` — check `page.hasMore` / `page.total`.',
    inputSchema: ListPlansArgs,
    execute: (c, args) =>
      c.request(
        'GET',
        `/api/v1/admin/applications/${encodeURIComponent(args.applicationId)}/plans${query({
          ...(args.includeInactive ? { includeInactive: true } : {}),
          limit: args.limit,
          offset: args.offset,
        })}`,
      ),
  },
  {
    name: 'list_coupons',
    description:
      'List discount coupons for an Application. PERCENT discounts use basis points (1500 = 15%); AMOUNT discounts use the smallest currency unit. ' +
      'Returns `{items, page}` — check `page.hasMore` / `page.total`.',
    inputSchema: ListCouponsArgs,
    execute: (c, args) =>
      c.request(
        'GET',
        `/api/v1/admin/applications/${encodeURIComponent(args.applicationId)}/coupons${query({
          ...(args.includeInactive ? { includeInactive: true } : {}),
          limit: args.limit,
          offset: args.offset,
        })}`,
      ),
  },
  {
    name: 'list_api_keys',
    description:
      'List active API keys for an Application. Returns metadata only — the raw key value is unrecoverable after creation, by design.',
    inputSchema: ListApiKeysArgs,
    execute: (c, args) =>
      c.request(
        'GET',
        `/api/v1/admin/applications/${encodeURIComponent(args.applicationId)}/api-keys`,
      ),
  },
  {
    name: 'list_payments',
    description:
      'List recent payments (newest first), optionally filtered to one Application and/or status. ' +
      'Each row carries applicationId, applicationSlug, endUserId, amount, currency, status, createdAt. ' +
      'Amounts are integers in the smallest currency unit (cents/paise/sen) — never floats.',
    inputSchema: ListPaymentsArgs,
    execute: async (c, args) => {
      const p = new URLSearchParams();
      if (args.applicationId !== undefined) p.set('applicationId', args.applicationId);
      if (args.status !== undefined) p.set('status', args.status);
      if (args.q !== undefined) p.set('q', args.q);
      if (args.sort !== undefined) p.set('sort', args.sort);
      if (args.order !== undefined) p.set('order', args.order);
      if (args.limit !== undefined) p.set('limit', String(args.limit));
      const qs = p.toString();
      // /admin/metrics/payments returns the `{items, page}` envelope. This
      // tool's contract is a bare payments array bounded by `limit`, so unwrap
      // to `.items` — the pagination metadata lives under `page` since
      // 2.0.0-rc.3 (it used to be flattened next to `items`).
      const result = await c.request<{ items: unknown[] }>(
        'GET',
        `/api/v1/admin/metrics/payments${qs ? `?${qs}` : ''}`,
      );
      return result.items;
    },
  },
  {
    name: 'get_payment_stats_by_app',
    description:
      'Billing/payment health per Application over the last 30 days: succeeded/failed/pending/refunded ' +
      'counts, success rate, and SUCCEEDED volume (volumeCents, smallest currency unit). Use this for ' +
      '"which apps are earning / failing payments" questions. (The richer per-app Billing Overview — MRR, ' +
      "12-month revenue series — lives at the panel-session-only endpoint /api/v1/tenant/applications/:id/billing/stats and isn't reachable with this server's credentials.)",
    inputSchema: PaymentStatsByAppArgs,
    execute: (c) => c.request('GET', '/api/v1/admin/metrics/payments-by-app'),
  },
  {
    name: 'mint_api_key',
    description:
      'WRITE: Mint a new secret API key (rp_live_…/rp_test_…) for an Application. The raw key is returned exactly ONCE — surface it to the user immediately and tell them it cannot be recovered. ' +
      'Authenticates as a SCOPED operator via REKEY_OPERATOR_TOKEN (not the admin key); the token must carry the `keys:mint` scope and belong to the workspace that owns the Application, or the call is rejected. ' +
      'Use this only when the user explicitly asks to create/mint an API key.',
    inputSchema: MintApiKeyArgs,
    execute: (c, args) =>
      c.requestAsOperator(
        'POST',
        `/api/v1/tenant/operator/applications/${encodeURIComponent(args.applicationId)}/api-keys`,
        {
          name: args.name,
          ...(args.scopes !== undefined ? { scopes: args.scopes } : {}),
        },
      ),
  },
];
