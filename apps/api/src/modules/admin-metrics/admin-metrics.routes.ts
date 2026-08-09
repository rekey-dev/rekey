/**
 * Super-admin metrics routes.
 *
 * Mounted at /api/v1/admin/metrics in app.ts. Every endpoint is GET-only and
 * gated by SUPER_ADMIN_KEY (requireSuperAdmin hook). The companion read-only
 * dashboard is the primary caller; CLI/scripts can also use it.
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
import { ok, okPage, okArray, errs, type JsonSchema } from '../../lib/openapi.js';

/**
 * The 401/403/429 trio every `/api/v1/admin/*` route shares — `requireSuperAdmin`
 * runs as an `onRequest` hook, so these precede any route-specific failure.
 */
const SUPER_ADMIN_ERRORS = {
  401:
    'ADMIN_AUTH_MISSING — no `Authorization: Bearer` header; or ADMIN_AUTH_INVALID — the ' +
    'value does not match `SUPER_ADMIN_KEY`.',
  403: 'ADMIN_IP_NOT_ALLOWED — the caller IP is outside `ADMIN_IP_ALLOWLIST`.',
  429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
} as const;

/**
 * Added to `SUPER_ADMIN_ERRORS` for every endpoint that parses its own
 * querystring with zod. None of these routes declare a Fastify `querystring`
 * schema (the zod `.parse()` in the handler is the *only* validator), so a
 * bad param surfaces as a `ZodError` — the global handler's `VALIDATION_ERROR`
 * branch, not the `BAD_REQUEST` a Fastify/AJV schema failure would produce.
 */
const LIST_QUERY_ERRORS = {
  400: 'VALIDATION_ERROR — a query parameter (e.g. `sort`, `order`, `limit`) failed validation.',
  ...SUPER_ADMIN_ERRORS,
} as const;

// ---------------------------------------------------------------------------
// Response shape fragments — one per service method. Modelled from the exact
// TS return types in admin-metrics.service.ts (read the JSDoc there for the
// semantics behind each field).
// ---------------------------------------------------------------------------

const OverviewSchema: JsonSchema = {
  type: 'object',
  description:
    'Deployment-wide rollup — tenants, applications, end-users, orgs, subscriptions, ' +
    'payments, MRR, webhook + API-request health over the last 24h/30d.',
  properties: {
    tenants: {
      type: 'object',
      properties: { total: { type: 'integer' }, newLast30d: { type: 'integer' } },
      required: ['total', 'newLast30d'],
    },
    applications: {
      type: 'object',
      properties: { total: { type: 'integer' }, newLast30d: { type: 'integer' } },
      required: ['total', 'newLast30d'],
    },
    endUsers: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        verified: { type: 'integer' },
        newLast24h: { type: 'integer' },
        newLast7d: { type: 'integer' },
        newLast30d: { type: 'integer' },
      },
      required: ['total', 'verified', 'newLast24h', 'newLast7d', 'newLast30d'],
    },
    organizations: {
      type: 'object',
      properties: { total: { type: 'integer' }, newLast30d: { type: 'integer' } },
      required: ['total', 'newLast30d'],
    },
    subscriptions: {
      type: 'object',
      properties: {
        pending: { type: 'integer' },
        active: { type: 'integer' },
        pastDue: { type: 'integer' },
        canceled: { type: 'integer' },
        expired: { type: 'integer' },
        total: { type: 'integer' },
      },
      required: ['pending', 'active', 'pastDue', 'canceled', 'expired', 'total'],
    },
    payments: {
      type: 'object',
      properties: {
        lifetime: {
          type: 'object',
          properties: { count: { type: 'integer' }, volumeCents: { type: 'integer' } },
          required: ['count', 'volumeCents'],
        },
        last30d: {
          type: 'object',
          properties: { count: { type: 'integer' }, volumeCents: { type: 'integer' } },
          required: ['count', 'volumeCents'],
        },
        succeededLast24h: { type: 'integer' },
        failedLast24h: { type: 'integer' },
      },
      required: ['lifetime', 'last30d', 'succeededLast24h', 'failedLast24h'],
    },
    mrrCents: {
      type: 'integer',
      description: 'SUM of ACTIVE subscriptions, YEAR-interval plans converted to a monthly figure.',
    },
    mrrCapped: {
      type: 'boolean',
      description:
        'True when the MRR read saturated its 10,000-row cap — `mrrCents` is then a lower ' +
        'bound, not the truth.',
    },
    webhooks: {
      type: 'object',
      properties: {
        eventsLast24h: { type: 'integer' },
        deliveriesLast24h: { type: 'integer' },
        deliveriesFailedLast24h: { type: 'integer' },
      },
      required: ['eventsLast24h', 'deliveriesLast24h', 'deliveriesFailedLast24h'],
    },
    apiRequests: {
      type: 'object',
      properties: {
        last24h: { type: 'integer' },
        errors4xxLast24h: { type: 'integer' },
        errors5xxLast24h: { type: 'integer' },
        avgDurationMs: { type: 'integer' },
      },
      required: ['last24h', 'errors4xxLast24h', 'errors5xxLast24h', 'avgDurationMs'],
    },
    tenantUsers: {
      type: 'object',
      properties: { total: { type: 'integer' }, activeLast30d: { type: 'integer' } },
      required: ['total', 'activeLast30d'],
    },
    lockedAccountsCount: {
      type: 'integer',
      description:
        'End-user accounts currently inside the Redis brute-force lockout window ' +
        '(`bf:lock:eu:login:*`). Does not include locked operator accounts.',
    },
    outstandingCredits: {
      type: 'integer',
      description: 'SUM(CreditBalance.balance) across all applications. Unit-less.',
    },
    emailLast24h: {
      type: 'object',
      properties: {
        sent: { type: 'integer' },
        error: { type: 'integer' },
        noTransport: { type: 'integer' },
        total: { type: 'integer' },
      },
      required: ['sent', 'error', 'noTransport', 'total'],
    },
  },
  required: [
    'tenants',
    'applications',
    'endUsers',
    'organizations',
    'subscriptions',
    'payments',
    'mrrCents',
    'mrrCapped',
    'webhooks',
    'apiRequests',
    'tenantUsers',
    'lockedAccountsCount',
    'outstandingCredits',
    'emailLast24h',
  ],
};

const ServicesSchema: JsonSchema = {
  type: 'object',
  description: 'Live DB + Redis ping, outbound webhook 24h success rate, oldest unprocessed inbound webhook.',
  properties: {
    api: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['up'] }, checkedAt: { type: 'string', format: 'date-time' } },
      required: ['status', 'checkedAt'],
    },
    database: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['up', 'down'] },
        latencyMs: { type: 'integer', nullable: true, description: 'Null when the ping itself failed.' },
      },
      required: ['status', 'latencyMs'],
    },
    redis: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['up', 'down', 'not_configured'],
          description: '`not_configured` when this deployment has no Redis (e.g. NODE_ENV=test).',
        },
        latencyMs: { type: 'integer', nullable: true },
      },
      required: ['status', 'latencyMs'],
    },
    webhookDeliverySuccessRate24h: {
      type: 'number',
      nullable: true,
      description: 'succeeded / total over the last 24h. Null when there were zero deliveries.',
    },
    oldestUnprocessedWebhookAgeSeconds: {
      type: 'integer',
      nullable: true,
      description: 'Age of the oldest inbound WebhookEvent with `processedAt: null`. Null when none are pending.',
    },
  },
  required: [
    'api',
    'database',
    'redis',
    'webhookDeliverySuccessRate24h',
    'oldestUnprocessedWebhookAgeSeconds',
  ],
};

const RetentionSchema: JsonSchema = {
  type: 'object',
  description:
    'End-user & operator active counts over 24h/7d/30d (refresh-token proxy) plus a 14-day ' +
    'end-user signup histogram.',
  properties: {
    endUsersActive: {
      type: 'object',
      properties: { last24h: { type: 'integer' }, last7d: { type: 'integer' }, last30d: { type: 'integer' } },
      required: ['last24h', 'last7d', 'last30d'],
    },
    operatorsActive: {
      type: 'object',
      properties: { last24h: { type: 'integer' }, last7d: { type: 'integer' }, last30d: { type: 'integer' } },
      required: ['last24h', 'last7d', 'last30d'],
    },
    signupTrend14d: {
      type: 'array',
      description: 'One entry per UTC day that had at least one signup — missing days are not zero-filled.',
      items: {
        type: 'object',
        properties: { date: { type: 'string', format: 'date' }, count: { type: 'integer' } },
        required: ['date', 'count'],
      },
    },
  },
  required: ['endUsersActive', 'operatorsActive', 'signupTrend14d'],
};

const TenantSummaryItem: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    ownerEmail: { type: 'string', format: 'email' },
    applicationCount: { type: 'integer' },
    endUserCount: { type: 'integer' },
    organizationCount: { type: 'integer' },
    activeSubscriptions: { type: 'integer' },
    mrrCents: { type: 'integer' },
    mrrCapped: {
      type: 'boolean',
      description: "True when this tenant's MRR sum saturated the 10,000-row read cap (lower bound).",
    },
    createdAt: { type: 'string', format: 'date-time' },
    lastActivityAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'Most recent ApiRequestLog row across the tenant\'s applications.',
    },
  },
  required: [
    'id',
    'name',
    'ownerEmail',
    'applicationCount',
    'endUserCount',
    'organizationCount',
    'activeSubscriptions',
    'mrrCents',
    'mrrCapped',
    'createdAt',
    'lastActivityAt',
  ],
};

const ApplicationSummaryItem: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    tenantId: { type: 'string' },
    tenantName: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    environment: { type: 'string', enum: ['PRODUCTION', 'STAGING', 'DEVELOPMENT'] },
    endUserCount: { type: 'integer' },
    activeSubscriptions: { type: 'integer' },
    apiRequestsLast24h: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'tenantId',
    'tenantName',
    'name',
    'slug',
    'environment',
    'endUserCount',
    'activeSubscriptions',
    'apiRequestsLast24h',
    'createdAt',
  ],
};

const EndUserSummaryItem: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    applicationId: { type: 'string' },
    applicationSlug: { type: 'string' },
    applicationName: { type: 'string' },
    email: { type: 'string', format: 'email' },
    emailVerified: { type: 'boolean' },
    role: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    lastSeenAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'Most recent RefreshToken.createdAt — a sign-in/refresh proxy.',
    },
  },
  required: [
    'id',
    'applicationId',
    'applicationSlug',
    'applicationName',
    'email',
    'emailVerified',
    'role',
    'createdAt',
    'lastSeenAt',
  ],
};

const TenantUserSummaryItem: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    email: { type: 'string', format: 'email' },
    name: { type: 'string', nullable: true },
    emailVerified: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
    membershipCount: { type: 'integer', description: 'Number of workspaces this operator belongs to.' },
  },
  required: ['id', 'email', 'name', 'emailVerified', 'createdAt', 'lastSeenAt', 'membershipCount'],
};

const SecurityEventSummaryItem: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    actorType: { type: 'string', enum: ['operator', 'end_user', 'system'] },
    actorId: { type: 'string', nullable: true },
    tenantId: { type: 'string', nullable: true },
    tenantName: {
      type: 'string',
      nullable: true,
      description: 'Resolved from `tenantId`; null if unset or the tenant is gone.',
    },
    applicationId: { type: 'string', nullable: true },
    applicationName: { type: 'string', nullable: true },
    applicationSlug: { type: 'string', nullable: true },
    ip: { type: 'string', nullable: true },
    userAgent: { type: 'string', nullable: true },
    metadata: { type: 'object', description: 'Event-specific detail; shape varies by `type`.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'type',
    'actorType',
    'actorId',
    'tenantId',
    'tenantName',
    'applicationId',
    'applicationName',
    'applicationSlug',
    'ip',
    'userAgent',
    'metadata',
    'createdAt',
  ],
};

const ApiRequestSummaryItem: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    method: { type: 'string' },
    routePath: { type: 'string' },
    statusCode: { type: 'integer' },
    durationMs: { type: 'integer' },
    applicationId: { type: 'string', nullable: true },
    tenantId: { type: 'string', nullable: true },
    operatorUserId: { type: 'string', nullable: true },
    ip: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'method',
    'routePath',
    'statusCode',
    'durationMs',
    'applicationId',
    'tenantId',
    'operatorUserId',
    'ip',
    'createdAt',
  ],
};

const AdminPaymentSummaryItem: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    applicationId: { type: 'string' },
    applicationSlug: { type: 'string' },
    endUserId: { type: 'string', nullable: true },
    amount: { type: 'integer', description: 'Minor currency units (cents).' },
    currency: { type: 'string' },
    status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'applicationId', 'applicationSlug', 'endUserId', 'amount', 'currency', 'status', 'createdAt'],
};

const AdminSubscriptionSummaryItem: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    applicationId: { type: 'string' },
    applicationSlug: { type: 'string' },
    endUserId: { type: 'string' },
    planSlug: { type: 'string' },
    planName: { type: 'string' },
    status: {
      type: 'string',
      enum: ['PENDING', 'ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'EXPIRED'],
    },
    currency: { type: 'string' },
    amount: { type: 'integer' },
    interval: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    currentPeriodEnd: { type: 'string', format: 'date-time', nullable: true },
  },
  required: [
    'id',
    'applicationId',
    'applicationSlug',
    'endUserId',
    'planSlug',
    'planName',
    'status',
    'currency',
    'amount',
    'interval',
    'createdAt',
    'currentPeriodEnd',
  ],
};

const WebhookEventSummaryItem: JsonSchema = {
  type: 'object',
  description: 'An inbound provider webhook (e.g. a Stripe event).',
  properties: {
    id: { type: 'string' },
    applicationId: { type: 'string' },
    applicationSlug: { type: 'string' },
    provider: { type: 'string' },
    eventType: { type: 'string' },
    receivedAt: { type: 'string', format: 'date-time' },
    processedAt: { type: 'string', format: 'date-time', nullable: true },
    processingError: { type: 'string', nullable: true },
  },
  required: [
    'id',
    'applicationId',
    'applicationSlug',
    'provider',
    'eventType',
    'receivedAt',
    'processedAt',
    'processingError',
  ],
};

const WebhookDeliverySummaryItem: JsonSchema = {
  type: 'object',
  description: "An outbound delivery attempt to a tenant's registered WebhookEndpoint.",
  properties: {
    id: { type: 'string' },
    endpointId: { type: 'string' },
    applicationId: { type: 'string' },
    applicationSlug: { type: 'string' },
    eventType: { type: 'string' },
    status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED'] },
    attempts: { type: 'integer' },
    responseStatus: { type: 'integer', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'endpointId',
    'applicationId',
    'applicationSlug',
    'eventType',
    'status',
    'attempts',
    'responseStatus',
    'createdAt',
  ],
};

const CreditLiabilitySchema: JsonSchema = {
  type: 'object',
  description: 'SUM(CreditBalance.balance) deployment-wide + top-20 applications by outstanding balance.',
  properties: {
    totalOutstanding: { type: 'integer', description: 'Unit-less — each application defines what a credit means.' },
    perApp: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          applicationId: { type: 'string' },
          applicationSlug: { type: 'string' },
          applicationName: { type: 'string' },
          outstanding: { type: 'integer' },
        },
        required: ['applicationId', 'applicationSlug', 'applicationName', 'outstanding'],
      },
    },
  },
  required: ['totalOutstanding', 'perApp'],
};

const LockedAccountsSchema: JsonSchema = {
  type: 'object',
  description:
    'Accounts currently inside the Redis brute-force lockout window — end-users AND operators.',
  properties: {
    total: { type: 'integer', description: 'Count of locked end-user accounts.' },
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'EndUser id, or a synthetic `<applicationId>:<email>` when the row is gone.',
          },
          applicationId: { type: 'string' },
          applicationSlug: { type: 'string' },
          email: { type: 'string', format: 'email' },
          failedAttempts: {
            type: 'integer',
            description: 'Reports the policy threshold, not a live counter (the counter is cleared at lock time).',
          },
          lockedUntil: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'applicationId', 'applicationSlug', 'email', 'failedAttempts', 'lockedUntil'],
      },
    },
    operatorsTotal: { type: 'integer', description: 'Count of locked OPERATOR accounts.' },
    operators: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'TenantUser id, or a synthetic `op:<email>` when the row is gone.',
          },
          email: { type: 'string', format: 'email' },
          workspaces: {
            type: 'array',
            description: 'Every workspace this operator belongs to — who else can still get in.',
            items: {
              type: 'object',
              properties: {
                tenantId: { type: 'string' },
                tenantName: { type: 'string' },
                role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
              },
              required: ['tenantId', 'tenantName', 'role'],
            },
          },
          failedAttempts: { type: 'integer' },
          lockedUntil: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'email', 'workspaces', 'failedAttempts', 'lockedUntil'],
      },
    },
  },
  required: ['total', 'accounts', 'operatorsTotal', 'operators'],
};

const EmailDeliverabilitySchema: JsonSchema = {
  type: 'object',
  description: 'EmailLog status counts over the last 24h + 7d, plus top-5 applications by error count (7d).',
  properties: {
    last24h: {
      type: 'object',
      properties: {
        sent: { type: 'integer' },
        error: { type: 'integer' },
        noTransport: { type: 'integer' },
        total: { type: 'integer' },
      },
      required: ['sent', 'error', 'noTransport', 'total'],
    },
    last7d: {
      type: 'object',
      properties: {
        sent: { type: 'integer' },
        error: { type: 'integer' },
        noTransport: { type: 'integer' },
        total: { type: 'integer' },
      },
      required: ['sent', 'error', 'noTransport', 'total'],
    },
    topErrorApps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          applicationId: { type: 'string' },
          applicationSlug: { type: 'string' },
          errors: { type: 'integer' },
        },
        required: ['applicationId', 'applicationSlug', 'errors'],
      },
    },
  },
  required: ['last24h', 'last7d', 'topErrorApps'],
};

const WebhookEndpointHealthItem: JsonSchema = {
  type: 'object',
  properties: {
    endpointId: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    applicationId: { type: 'string' },
    applicationSlug: { type: 'string' },
    succeeded: { type: 'integer' },
    failed: { type: 'integer' },
    pending: { type: 'integer' },
    successRate: {
      type: 'number',
      nullable: true,
      description: 'succeeded / (succeeded+failed+pending) over the last 24h. Null when there were zero deliveries.',
    },
  },
  required: ['endpointId', 'url', 'applicationId', 'applicationSlug', 'succeeded', 'failed', 'pending', 'successRate'],
};

const PaymentsByAppItem: JsonSchema = {
  type: 'object',
  properties: {
    applicationId: { type: 'string' },
    applicationSlug: { type: 'string' },
    applicationName: { type: 'string' },
    succeeded: { type: 'integer' },
    failed: { type: 'integer' },
    pending: { type: 'integer' },
    refunded: { type: 'integer' },
    successRate: {
      type: 'number',
      nullable: true,
      description: 'succeeded / (succeeded+failed) over the last 30 days. Null when both are zero.',
    },
    volumeCents: {
      type: 'integer',
      description: 'SUCCEEDED payment volume in minor currency units over the last 30 days.',
    },
  },
  required: [
    'applicationId',
    'applicationSlug',
    'applicationName',
    'succeeded',
    'failed',
    'pending',
    'refunded',
    'successRate',
    'volumeCents',
  ],
};

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
  status: z.enum(['PENDING', 'ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'EXPIRED']).optional(),
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
        response: {
          200: ok(OverviewSchema, 'The deployment-wide rollup.'),
          ...errs(SUPER_ADMIN_ERRORS),
        },
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
        response: {
          200: ok(ServicesSchema, 'Live service-health snapshot.'),
          ...errs(SUPER_ADMIN_ERRORS),
        },
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
        response: {
          200: ok(RetentionSchema, 'Active-user counts + the 14-day signup trend.'),
          ...errs(SUPER_ADMIN_ERRORS),
        },
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
        response: {
          200: okPage(TenantSummaryItem, 'A page of per-tenant summaries.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: okPage(ApplicationSummaryItem, 'A page of per-application summaries.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: okPage(EndUserSummaryItem, 'A page of end-users.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: okPage(TenantUserSummaryItem, 'A page of operator accounts.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: okPage(SecurityEventSummaryItem, 'A page of security events, newest first by default.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: okPage(ApiRequestSummaryItem, 'A page of logged API requests.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: okPage(AdminPaymentSummaryItem, 'A page of payments.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: okPage(AdminSubscriptionSummaryItem, 'A page of subscriptions.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: okPage(WebhookEventSummaryItem, 'A page of inbound webhook events.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: okPage(WebhookDeliverySummaryItem, 'A page of outbound webhook deliveries.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: ok(CreditLiabilitySchema, 'Outstanding prepaid credit liability.'),
          ...errs(SUPER_ADMIN_ERRORS),
        },
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
        summary: 'Accounts in lockout (end-users and operators)',
        description:
          'Accounts currently locked by the Redis brute-force limiter — failed-sign-in ' +
          'protection currently engaged.\n\n' +
          '`accounts` lists end-users (`bf:lock:eu:login:*`). `operators` lists OPERATOR ' +
          'accounts (`bf:lock:op:login:*`) with the workspaces each belongs to: a locked-out ' +
          'workspace owner cannot reach their own security log, so this is the only surface ' +
          'that shows them.',
        response: {
          200: ok(LockedAccountsSchema, 'End-users and operators currently locked out.'),
          ...errs(LIST_QUERY_ERRORS),
        },
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
        response: {
          200: ok(EmailDeliverabilitySchema, 'Email transport health.'),
          ...errs(SUPER_ADMIN_ERRORS),
        },
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
        response: {
          200: okArray(
            WebhookEndpointHealthItem,
            'Top 20 endpoints by failure count over the last 24h. Bounded by construction — not paginated.',
          ),
          ...errs(SUPER_ADMIN_ERRORS),
        },
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
        response: {
          200: okArray(
            PaymentsByAppItem,
            'Top 20 applications by failed-payment count over the last 30 days. Bounded by construction — not paginated.',
          ),
          ...errs(SUPER_ADMIN_ERRORS),
        },
      },
    },
    async () => ({ success: true, data: await adminMetricsService.paymentsByApp() }),
  );
}
