/**
 * Super-admin metrics routes.
 *
 * Mounted at /api/v1/admin/metrics in app.ts. Every endpoint is GET-only and
 * gated by SUPER_ADMIN_KEY (requireSuperAdmin hook). The companion read-only
 * dashboard (apps/admin) is the primary caller; CLI/scripts can also use it.
 *
 * Naming convention: noun-only routes; the verb is always GET.
 *
 * Query-string conventions across list endpoints:
 *   limit  — page size (1..200, default per route)
 *   q      — free-text search across the natural identity columns (varies
 *            by resource; see each `query.q` block in the service)
 *   sort   — field name (typed per resource)
 *   order  — 'asc' | 'desc' (defaults to 'desc' on time-based fields)
 *   plus per-resource filters (status / actorType / applicationId / etc.)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminMetricsService } from './admin-metrics.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';

const Order = z.enum(['asc', 'desc']).optional();
const Limit = z.coerce.number().int().positive().max(200).optional();
const Offset = z.coerce.number().int().min(0).max(1_000_000).optional();
const Q = z.string().trim().min(1).max(200).optional();

const TenantsQuery = z.object({
  limit: Limit,
  offset: Offset,
  q: Q,
  sort: z.enum(['createdAt', 'name', 'mrrCents', 'endUserCount', 'applicationCount', 'lastActivityAt']).optional(),
  order: Order,
});

const ApplicationsQuery = z.object({
  limit: Limit,
  offset: Offset,
  q: Q,
  sort: z.enum(['createdAt', 'name', 'slug', 'endUserCount', 'activeSubscriptions', 'apiRequestsLast24h']).optional(),
  order: Order,
  tenantId: z.string().min(1).optional(),
});

const EndUsersQuery = z.object({
  limit: Limit,
  offset: Offset,
  q: Q,
  sort: z.enum(['createdAt', 'email', 'lastSeenAt']).optional(),
  order: Order,
  applicationId: z.string().min(1).optional(),
});

const TenantUsersQuery = z.object({
  limit: Limit,
  offset: Offset,
  q: Q,
  sort: z.enum(['createdAt', 'email', 'lastSeenAt']).optional(),
  order: Order,
});

const SecurityEventsQuery = z.object({
  limit: Limit,
  offset: Offset,
  q: Q,
  order: Order,
  actorType: z.enum(['operator', 'end_user', 'system']).optional(),
  type: z.string().trim().min(1).max(200).optional(),
  tenantId: z.string().min(1).optional(),
  applicationId: z.string().min(1).optional(),
  ip: z.string().trim().min(1).max(64).optional(),
});

const ApiRequestsQuery = z.object({
  limit: Limit,
  offset: Offset,
  order: Order,
  sort: z.enum(['createdAt', 'durationMs', 'statusCode']).optional(),
  method: z.string().trim().min(1).max(10).optional(),
  pathContains: z.string().trim().min(1).max(200).optional(),
  statusGte: z.coerce.number().int().optional(),
  statusLt: z.coerce.number().int().optional(),
  applicationId: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  operatorUserId: z.string().min(1).optional(),
  ip: z.string().trim().min(1).max(64).optional(),
});

const PaymentsQuery = z.object({
  limit: Limit,
  offset: Offset,
  q: Q,
  order: Order,
  sort: z.enum(['createdAt', 'amount']).optional(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']).optional(),
  applicationId: z.string().min(1).optional(),
});

const SubscriptionsQuery = z.object({
  limit: Limit,
  offset: Offset,
  q: Q,
  order: Order,
  status: z.enum(['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED']).optional(),
  applicationId: z.string().min(1).optional(),
});

const WebhookEventsQuery = z.object({
  limit: Limit,
  offset: Offset,
  order: Order,
  provider: z.string().trim().min(1).max(40).optional(),
  applicationId: z.string().min(1).optional(),
  onlyFailed: z.coerce.boolean().optional(),
});

const WebhookDeliveriesQuery = z.object({
  limit: Limit,
  offset: Offset,
  order: Order,
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']).optional(),
  applicationId: z.string().min(1).optional(),
  endpointId: z.string().min(1).optional(),
});

export async function adminMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.get(
    '/overview',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Deployment-wide rollup',
        description: 'Tenants, applications, end-users, orgs, subscriptions, payments, MRR, webhook + API-request health over the last 24h/30d.',
      },
    },
    async () => ({ success: true, data: await adminMetricsService.overview() }),
  );

  app.get(
    '/services',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Service health',
        description: 'Live DB + Redis ping, outbound webhook 24h success rate, oldest unprocessed inbound webhook.',
      },
    },
    async () => ({ success: true, data: await adminMetricsService.services() }),
  );

  app.get(
    '/retention',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Active users & signup trend',
        description: 'End-user & operator active counts over 24h/7d/30d (refresh-token proxy) plus a 14-day end-user signup histogram.',
      },
    },
    async () => ({ success: true, data: await adminMetricsService.retention() }),
  );

  app.get(
    '/tenants',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Per-tenant summary (searchable + sortable)',
      },
    },
    async (req) => {
      const query = TenantsQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.tenants(query) };
    },
  );

  app.get(
    '/applications',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Per-application summary (searchable + sortable)',
      },
    },
    async (req) => {
      const query = ApplicationsQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.applications(query) };
    },
  );

  app.get(
    '/end-users',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'End-users (search by email/id)',
      },
    },
    async (req) => {
      const query = EndUsersQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.endUsers(query) };
    },
  );

  app.get(
    '/tenant-users',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Operator accounts (search by email/name/id)',
      },
    },
    async (req) => {
      const query = TenantUsersQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.tenantUsers(query) };
    },
  );

  app.get(
    '/security-events',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Security audit (filter by actor/type/ip)',
      },
    },
    async (req) => {
      const query = SecurityEventsQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.securityEvents(query) };
    },
  );

  app.get(
    '/api-requests',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'API request log (filter by status/method/path)',
      },
    },
    async (req) => {
      const query = ApiRequestsQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.apiRequests(query) };
    },
  );

  app.get(
    '/payments',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Payments (filter by status, search by id/provider-id)',
      },
    },
    async (req) => {
      const query = PaymentsQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.payments(query) };
    },
  );

  app.get(
    '/subscriptions',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Subscriptions (filter by status)',
      },
    },
    async (req) => {
      const query = SubscriptionsQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.subscriptions(query) };
    },
  );

  app.get(
    '/webhook-events',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Inbound webhook events (filter by provider, onlyFailed)',
      },
    },
    async (req) => {
      const query = WebhookEventsQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.webhookEvents(query) };
    },
  );

  app.get(
    '/webhook-deliveries',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Outbound webhook deliveries (filter by status/endpoint)',
      },
    },
    async (req) => {
      const query = WebhookDeliveriesQuery.parse(req.query);
      return { success: true, data: await adminMetricsService.webhookDeliveries(query) };
    },
  );

  app.get(
    '/credit-liability',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Outstanding prepaid credits',
        description: 'SUM(CreditBalance.balance) deployment-wide + top-20 applications by outstanding balance.',
      },
    },
    async () => ({ success: true, data: await adminMetricsService.creditLiability() }),
  );

  app.get(
    '/locked-accounts',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'End-user accounts in lockout',
        description: 'End-users currently locked by the Redis brute-force limiter (`bf:lock:eu:login:*`) — failed-sign-in protection currently engaged.',
      },
    },
    async (req) => {
      const query = z
        .object({
          limit: z.coerce.number().int().positive().max(200).optional(),
          sort: z.enum(['lockedUntil', 'failedSignInAttempts']).optional(),
          order: z.enum(['asc', 'desc']).optional(),
        })
        .parse(req.query);
      return { success: true, data: await adminMetricsService.lockedAccounts(query) };
    },
  );

  app.get(
    '/email-deliverability',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Email transport rollup',
        description: 'EmailLog status counts over the last 24h + 7d, plus top-5 applications by error count (7d).',
      },
    },
    async () => ({ success: true, data: await adminMetricsService.emailDeliverability() }),
  );

  app.get(
    '/webhook-endpoint-health',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Per-endpoint webhook health (24h)',
        description: 'Outbound deliveries aggregated by endpoint — success rate + retry-storm flag. Sorted by failure count.',
      },
    },
    async () => ({ success: true, data: await adminMetricsService.webhookEndpointHealth() }),
  );

  app.get(
    '/payments-by-app',
    {
      schema: {
        tags: ['Admin · Metrics'],
        security: [{ superAdminKey: [] }],
        summary: 'Payment health per application (30d)',
        description: 'Payments aggregated by application + status over the last 30 days. Surfaces apps whose provider integration is failing.',
      },
    },
    async () => ({ success: true, data: await adminMetricsService.paymentsByApp() }),
  );
}
