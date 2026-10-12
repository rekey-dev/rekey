/**
 * MCP tool registry. Each tool is a `(client, args) → result` function with
 * a Zod-described input schema. The server (index.ts) wires them up.
 *
 * The deployment-wide read tools in this file authenticate with the admin
 * key. Every WRITE tool, and the billing tools of one Application (see
 * `billing-tools.ts`), authenticate instead with a SCOPED operator
 * personal-access-token (`REKEY_OPERATOR_TOKEN`), and the server refuses them
 * unless that PAT carries the scope the route asks for: default-deny, so an
 * agent cannot change production unless explicitly granted. See AGENTS.md.
 */

import { z } from 'zod';
import { billingTools } from './billing-tools.js';
import { MINOR_UNITS, PagingArgs, query, type ToolDefinition } from './tool-types.js';

export type { ToolDefinition } from './tool-types.js';

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
  includeInactive: z.boolean().optional().describe('If true, include deactivated coupons.'),
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
    .describe('Filter by payment status. A partly refunded payment has the status PARTIALLY_REFUNDED, which this filter cannot select.'),
  q: z
    .string()
    .optional()
    .describe('Exact-match search: payment id, provider payment id, or end-user id.'),
  sort: z
    .enum(['createdAt', 'amount'])
    .optional()
    .describe('Sort field. Default createdAt. `amount` compares the stored integers, so it mixes currencies.'),
  order: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default desc.'),
  limit: z.number().int().min(1).max(200).optional().describe('Page size, 1–200. Default 50.'),
});

const PaymentStatsByAppArgs = z.object({});

const BillingOutboxArgs = z.object({});

export const tools: Array<ToolDefinition<z.ZodRawShape>> = [
  {
    name: 'list_tenants',
    description:
      'List Tenants. Tenants are the outer multi-tenancy unit (one per Rekey customer). Use this when the user asks "what tenants exist" or to find a tenantId to drill into. ' +
      'Returns `{items, page}`, check `page.hasMore` / `page.total` before concluding you have seen them all, and pass `offset` for the next window.',
    inputSchema: ListTenantsArgs,
    execute: (c, args) => c.request('GET', `/api/v1/admin/tenants${query(args)}`),
  },
  {
    name: 'list_applications',
    description:
      'List Applications, optionally filtered by Tenant. An Application is one project under a Tenant; every domain row in Rekey carries an applicationId. Use this to find the applicationId for subsequent calls. ' +
      'Returns `{items, page}`, check `page.hasMore` / `page.total` before concluding you have seen them all.',
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
      'List Plans for an Application. Each plan carries `prices`, every price it sells at with the default one first: `id`, `currency`, ' +
      `\`amount\` (${MINOR_UNITS}), \`countries\` (where a non-default price applies; empty means wherever its currency is the local one), \`isDefault\`, \`registration\` (where the price stands at the payment provider), \`amountEditable\` (false once a provider holds the price or a subscription, an open checkout, a payment or a credit grant names it, after which its amount cannot change) and \`liveSubscriptions\` and \`openCheckouts\` (counts of who is on it; a price with either above 0 cannot be removed). ` +
      "`defaultPriceId` names the default price and is null for a plan with no flat price; `isFree` says the plan charges nothing. A plan has no `amount` or `currency` of its own: `price` is the price a buyer with no country would be charged. " +
      'Returns `{items, page}`, check `page.hasMore` / `page.total`.',
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
      'List discount coupons for an Application. A PERCENT coupon carries `basisPoints` (1500 = 15%) and works in any currency unless `currencies` limits it. ' +
      `An AMOUNT coupon carries \`amounts\`, one \`{currency, amountOff}\` per currency (\`amountOff\`: ${MINOR_UNITS}), and works only in those currencies. ` +
      '`coveredCurrencies` is every currency a checkout may use the coupon in, or null for any. ' +
      'Returns `{items, page}`, check `page.hasMore` / `page.total`.',
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
      'List active API keys for an Application. Returns metadata only, the raw key value is unrecoverable after creation, by design.',
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
      `\`amount\` is an ${MINOR_UNITS}: read it with the row's \`currency\`, and never add rows in different currencies.`,
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
      // to `.items`, the pagination metadata lives under `page` since
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
      'counts, success rate, and `volumeByCurrency`: the net volume of verified payments, one `{currency, volumeCents, payments}` entry per currency ' +
      `(\`volumeCents\` is an ${MINOR_UNITS} despite its name). There is no total across currencies. Use this for ` +
      '"which apps are earning / failing payments" questions. For one Application\'s MRR and 12-month revenue series, use `get_billing_stats`.',
    inputSchema: PaymentStatsByAppArgs,
    execute: (c) => c.request('GET', '/api/v1/admin/metrics/payments-by-app'),
  },
  {
    name: 'get_billing_outbox_status',
    description:
      'Billing events waiting to reach the billing log, across every Application: `pending`, `due`, and `failing` (rows that have failed `failingThreshold` times or more). ' +
      '`stuck` lists the failing rows with the error of their last attempt. Each stuck row is an event missing from its Application\'s billing log until it drains. No event payload is returned.',
    inputSchema: BillingOutboxArgs,
    execute: (c) => c.request('GET', '/api/v1/admin/metrics/billing-outbox'),
  },
  {
    name: 'mint_api_key',
    description:
      'WRITE: Mint a new secret API key (rp_live_…/rp_test_…) for an Application. The raw key is returned exactly ONCE, surface it to the user immediately and tell them it cannot be recovered. ' +
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
  ...billingTools,
];
