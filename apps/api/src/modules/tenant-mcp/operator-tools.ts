/**
 * Operator MCP tools — read-only views of the *authenticated operator's*
 * accessible workspace data, scoped to (tenantUserId, tenantId).
 *
 * Distinct from the per-Application end-user MCP server in `modules/mcp/`
 * (which surfaces a single end-user's account). These tools answer
 * operator-side questions: "what apps do I run?", "how many end-users?",
 * "what payments succeeded today?", "what webhooks are failing?".
 *
 * Every tool is a plain `{ name, description, inputSchema, handler }`. The
 * MCP JSON-RPC layer in `tenant-mcp-server.ts` lists + dispatches them. Kept
 * transport- and SDK-agnostic so the handlers are unit-testable directly.
 *
 * Two credentials reach here (see `bearer-auth.ts`): a PAT, whose workspace is
 * pinned by `TenantApiToken.tenantId`, or an OAuth access token, whose workspace
 * comes from the `tid` the operator consented to. Both re-check membership on
 * every request. But tenant isolation itself is each handler filtering on
 * `ctx.tenantId` — a convention every new tool must follow, not a property the
 * type system or the guard can enforce for you.
 *
 * ## Reads are authorized, not merely tenant-scoped
 *
 * "Authorization is the caller's responsibility" used to be the whole model
 * here, and the write tools were the only ones that had any. Read tools were
 * described as "always available", which in practice meant an `APP_VIEWER`
 * MEMBER — someone granted sight of exactly one Application — could mint
 * themselves an OAuth token and read every OTHER Application's end-users plus
 * the full workspace security log, IPs and user agents included. The REST
 * equivalents answer 404 and 403 for the same caller. Two authorization models
 * over one dataset is one authorization model plus a bypass.
 *
 * So the read tools now apply the same two gates the REST routes do:
 *
 *   - **Role.** `minRole` is honoured for read tools, not just write ones.
 *     `recent_security_events` and `list_invitations` are OWNER/ADMIN, matching
 *     `securityEventsRoutes` and the workspace invitations list.
 *   - **Per-application grants.** Every tool that reads Application-scoped data
 *     resolves its Application set through `accessibleApplicationIds`, which
 *     mirrors `lib/app-access.ts` exactly — including the legacy rule that a
 *     MEMBER with zero grants anywhere keeps workspace-wide READ.
 *
 * `get_end_user` is the one that needed both, and it is the pattern for any new
 * tool that takes an `applicationId`: resolve through the helper, and report a
 * denied Application identically to a non-existent one.
 */

import type { TenantRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { tenantWorkspacesService } from '../tenant-workspaces/tenant-workspaces.service.js';

export interface OperatorToolContext {
  tenantUserId: string;
  tenantId: string;
  /** The operator's live role in `tenantId`, re-checked by the auth guard. */
  role: TenantRole;
  /**
   * The caller's `TenantMembership.id` in `tenantId` — the key
   * `ApplicationGrant` rows hang off. Set by both auth paths in
   * `bearer-auth.ts`; without it a MEMBER's grants cannot be resolved and
   * `accessibleApplicationIds` refuses rather than guessing.
   */
  tenantMembershipId?: string | undefined;
  /** Whether this token carries write scope (`mcp:operator:write` / PAT `applications:write`). */
  canWrite: boolean;
  /** Whether this token carries admin scope (`mcp:operator:admin`) — destructive/financial ops. */
  canAdmin: boolean;
  /** Inbound request context, threaded through for the security audit log. */
  ip?: string | null;
  userAgent?: string | null;
}

export interface OperatorTool {
  name: string;
  description: string;
  /** JSON Schema for tool arguments. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    additionalProperties: boolean;
    required?: string[];
  };
  /**
   * A mutating tool. Listed + dispatchable only when the caller's token carries
   * write scope AND their role is allowed (see `minRole`). Defaults to false —
   * a plain read tool.
   */
  write?: boolean;
  /**
   * A destructive / financial / secret-handling tool. Requires the token to
   * carry admin scope (`mcp:operator:admin`) AND the role to clear `minRole`.
   * `admin` implies `write` for gating purposes. Defaults to false.
   */
  admin?: boolean;
  /**
   * Minimum tenant role allowed to call this tool.
   *
   * For write/admin tools it defaults to `ADMIN` (so OWNER + ADMIN may call;
   * MEMBER may not). For READ tools there is no default — most workspace reads
   * are open to any member, as they are over REST — but setting it here gates
   * them, and it is honoured. It used to be documented as "ignored for read
   * tools", which is how the workspace security log (IPs, user agents, every
   * sign-in) ended up readable by a MEMBER through MCP while the REST route
   * answered 403.
   */
  minRole?: TenantRole;
  handler: (ctx: OperatorToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

const NO_ARGS = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Clamp a JSON-RPC `limit` arg to [1, 200]; default 25. */
function clampLimit(raw: unknown, def = 25): number {
  const n = typeof raw === 'number' ? raw : raw === undefined ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(1, Math.floor(n)), 200);
}

/**
 * The Applications this caller may READ, as ids — the MCP equivalent of
 * `appAccessScope` + `ensureAppAccess(…, 'read')` in `lib/app-access.ts`.
 *
 * The matrix is that file's, reproduced here rather than shared because the
 * REST helper takes a `FastifyRequest` and these handlers have no request:
 *
 *   OWNER / ADMIN     → every Application in the workspace.
 *   MEMBER            → exactly the granted Applications, at any grant role
 *                       (APP_VIEWER included — every grant confers read).
 *                       Zero grants therefore means zero Applications: since
 *                       2.0.0-rc.3 grant-scoped access is the DEFAULT, not a
 *                       mode you opt into with your first grant.
 *   MEMBER, with      → every Application in the workspace (LEGACY read).
 *   legacyWorkspace     Set only by the 2.0.0-rc.3 backfill, for memberships
 *   Read = true         that predate grant-scoped-by-default.
 *
 * If the two ever diverge, this is the copy to fix: REST is the contract.
 *
 * Returns `[]` for a caller with grants that name no Application, which every
 * handler treats as "nothing to show" — the same empty result an operator with
 * no Applications gets, so a denied Application is indistinguishable from an
 * absent one.
 */
export async function accessibleApplicationIds(ctx: OperatorToolContext): Promise<string[]> {
  const all = await prisma.application.findMany({
    where: { tenantId: ctx.tenantId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const allIds = all.map((a) => a.id);
  if (ctx.role === 'OWNER' || ctx.role === 'ADMIN') return allIds;
  // No membership id means grants cannot be resolved. Fail CLOSED: a MEMBER
  // whose grants we cannot read must not be handed the workspace.
  if (!ctx.tenantMembershipId) return [];
  const [grants, membership] = await Promise.all([
    prisma.applicationGrant.findMany({
      where: { tenantMembershipId: ctx.tenantMembershipId },
      select: { applicationId: true },
    }),
    prisma.tenantMembership.findUnique({
      where: { id: ctx.tenantMembershipId },
      select: { legacyWorkspaceRead: true },
    }),
  ]);
  // Grandfathered pre-grants membership only. Zero grants alone now means
  // zero Applications, matching lib/app-access.ts.
  if (grants.length === 0 && membership?.legacyWorkspaceRead === true) return allIds;
  const granted = new Set(grants.map((g) => g.applicationId));
  return allIds.filter((id) => granted.has(id));
}

export const operatorTools: OperatorTool[] = [
  {
    name: 'get_workspace_overview',
    description:
      "Top-level rollup for the Applications the authenticated operator can " +
      'read in their active workspace: application count, end-user count, ' +
      'organization count, active subscriptions and MRR (in minor currency ' +
      'units, e.g. cents).',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      // Grant-scoped: a MEMBER with one APP_VIEWER grant used to get counts and
      // revenue for the whole workspace out of this rollup.
      const appIds = await accessibleApplicationIds(ctx);
      const apps = await prisma.application.findMany({
        where: { id: { in: appIds } },
        select: { id: true, slug: true, name: true },
      });
      if (appIds.length === 0) {
        return {
          tenantId: ctx.tenantId,
          applicationCount: 0,
          endUserCount: 0,
          organizationCount: 0,
          activeSubscriptions: 0,
          mrrMinor: 0,
          currencies: [],
        };
      }
      const [endUserCount, orgCount, activeSubsRows] = await Promise.all([
        prisma.endUser.count({ where: { applicationId: { in: appIds } } }),
        prisma.organization.count({ where: { applicationId: { in: appIds } } }),
        prisma.subscription.findMany({
          where: { applicationId: { in: appIds }, status: 'ACTIVE' },
          select: {
            plan: { select: { amount: true, interval: true, currency: true } },
          },
          take: 10000,
        }),
      ]);
      // MRR aggregated per currency — workspaces may have multi-currency plans.
      const mrrByCurrency = new Map<string, number>();
      for (const s of activeSubsRows) {
        if (!s.plan) continue;
        const monthly = s.plan.interval === 'YEAR' ? Math.floor(s.plan.amount / 12) : s.plan.amount;
        mrrByCurrency.set(s.plan.currency, (mrrByCurrency.get(s.plan.currency) ?? 0) + monthly);
      }
      // For backward-friendly clients, sum all currencies' minor values into a
      // single number too — only meaningful when the workspace is single-currency.
      const mrrMinor = [...mrrByCurrency.values()].reduce((a, b) => a + b, 0);
      return {
        tenantId: ctx.tenantId,
        applicationCount: apps.length,
        endUserCount,
        organizationCount: orgCount,
        activeSubscriptions: activeSubsRows.length,
        mrrMinor,
        currencies: [...mrrByCurrency.entries()].map(([currency, mrr]) => ({ currency, mrrMinor: mrr })),
      };
    },
  },
  {
    name: 'list_applications',
    description:
      "List the Applications the operator can read in their active workspace — " +
      'id, slug, name, end-user count, active-subscription count, request volume ' +
      'in last 24h. A MEMBER with per-application grants sees only the granted ones.',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const since24h = new Date(Date.now() - DAY_MS);
      const appIds = await accessibleApplicationIds(ctx);
      const apps = await prisma.application.findMany({
        where: { id: { in: appIds } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, slug: true, name: true, createdAt: true },
      });
      const enriched = await Promise.all(
        apps.map(async (a) => {
          const [endUserCount, activeSubs, requests24h] = await Promise.all([
            prisma.endUser.count({ where: { applicationId: a.id } }),
            prisma.subscription.count({ where: { applicationId: a.id, status: 'ACTIVE' } }),
            prisma.apiRequestLog.count({
              where: { applicationId: a.id, createdAt: { gte: since24h } },
            }),
          ]);
          return {
            id: a.id,
            slug: a.slug,
            name: a.name,
            endUserCount,
            activeSubscriptions: activeSubs,
            apiRequestsLast24h: requests24h,
            createdAt: a.createdAt.toISOString(),
          };
        }),
      );
      return { applications: enriched };
    },
  },
  {
    name: 'list_members',
    description:
      "List operators in the active workspace and their roles (OWNER / ADMIN / MEMBER). " +
      'No password hashes or refresh-token data.',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const memberships = await prisma.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId },
        include: {
          tenantUser: {
            select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      return {
        members: memberships.map((m) => ({
          tenantUserId: m.tenantUserId,
          email: m.tenantUser.email,
          name: m.tenantUser.name,
          emailVerified: m.tenantUser.emailVerified,
          role: m.role,
          joinedAt: m.createdAt.toISOString(),
        })),
      };
    },
  },
  {
    name: 'list_invitations',
    description:
      'List workspace invitations and their status (pending / accepted / expired / revoked). ' +
      'Use an id here with revoke_invitation. No invite tokens are returned. ' +
      'Requires the OWNER or ADMIN workspace role.',
    // Matches GET /api/v1/tenant/workspace/invitations, which is OWNER/ADMIN.
    // A pending-invite list names people the workspace is recruiting.
    minRole: 'ADMIN',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      // Bounded like every other MCP list tool — the service now pages, and an
      // unbounded call would hand a model the entire invitation history.
      const { items: rows } = await tenantWorkspacesService.listInvitations(ctx.tenantId, {
        take: 100,
      });
      return {
        invitations: rows.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          status: r.status,
          expiresAt: r.expiresAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  },
  {
    name: 'recent_payments',
    description:
      'Recent Payment rows across the Applications the operator can read — by default ' +
      'the last 25, max 200. Filter optionally by `status` (SUCCEEDED / FAILED / ' +
      "PENDING / REFUNDED). Each row reports its Application's environment.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
        status: { type: 'string', enum: ['SUCCEEDED', 'FAILED', 'PENDING', 'REFUNDED'] },
      },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const limit = clampLimit(args.limit);
      const status = typeof args.status === 'string' ? args.status : undefined;
      // Grant-scoped, not merely tenant-scoped — see `accessibleApplicationIds`.
      const appIds = await accessibleApplicationIds(ctx);
      if (appIds.length === 0) return { payments: [] };
      const rows = await prisma.payment.findMany({
        where: {
          applicationId: { in: appIds },
          ...(status ? { status: status as 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'REFUNDED' } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { application: { select: { slug: true, environment: true } } },
      });
      return {
        payments: rows.map((r) => ({
          id: r.id,
          applicationSlug: r.application.slug,
          endUserId: r.endUserId,
          amountMinor: r.amount,
          currency: r.currency,
          status: r.status,
          environment: r.application.environment,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  },
  {
    name: 'recent_subscriptions',
    description:
      'Recent Subscription rows across the workspace — by default the last 25, max ' +
      '200. Filter optionally by `status` (PENDING / ACTIVE / PAST_DUE / CANCELED / EXPIRED). ' +
      "Each row reports its Application's environment and its id (use the id with " +
      'cancel_subscription).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
        status: {
          type: 'string',
          enum: ['PENDING', 'ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'EXPIRED'],
        },
      },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const limit = clampLimit(args.limit);
      const status = typeof args.status === 'string' ? args.status : undefined;
      // Grant-scoped, not merely tenant-scoped — see `accessibleApplicationIds`.
      const appIds = await accessibleApplicationIds(ctx);
      if (appIds.length === 0) return { subscriptions: [] };
      const rows = await prisma.subscription.findMany({
        where: {
          applicationId: { in: appIds },
          ...(status
            ? { status: status as 'PENDING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED' }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          application: { select: { slug: true, environment: true } },
          plan: { select: { slug: true, name: true, amount: true, currency: true, interval: true } },
        },
      });
      return {
        subscriptions: rows.map((r) => ({
          id: r.id,
          applicationSlug: r.application.slug,
          endUserId: r.endUserId,
          planSlug: r.plan.slug,
          planName: r.plan.name,
          status: r.status,
          environment: r.application.environment,
          amountMinor: r.plan.amount,
          currency: r.plan.currency,
          interval: r.plan.interval,
          currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  },
  {
    name: 'recent_security_events',
    description:
      "Most recent rows from the workspace's security audit log. Best for incident " +
      'response — answers "what did IP X do?" / "who signed in when?". Requires the ' +
      'OWNER or ADMIN workspace role.',
    // Matches GET /api/v1/tenant/security-events, which is OWNER/ADMIN because
    // the log carries IPs and user agents for every operator and end-user in
    // the workspace. Reachable by any MEMBER here until now.
    minRole: 'ADMIN',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
        actorType: { type: 'string', enum: ['operator', 'end_user', 'system'] },
      },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const limit = clampLimit(args.limit);
      const actorType = typeof args.actorType === 'string' ? args.actorType : undefined;
      const rows = await prisma.securityEvent.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(actorType ? { actorType } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return {
        events: rows.map((r) => ({
          id: r.id,
          type: r.type,
          actorType: r.actorType,
          actorId: r.actorId,
          applicationId: r.applicationId,
          ip: r.ip,
          userAgent: r.userAgent,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  },
  {
    name: 'recent_webhook_events',
    description:
      "Recent inbound provider webhooks (Stripe / PayPal / Razorpay) received by " +
      "the workspace's Applications. Filter optionally by `provider` or set " +
      "`onlyFailed: true` to surface unprocessed / failed-to-process events.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
        provider: { type: 'string' },
        onlyFailed: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const limit = clampLimit(args.limit);
      const provider = typeof args.provider === 'string' ? args.provider : undefined;
      const onlyFailed = args.onlyFailed === true;
      // Grant-scoped, not merely tenant-scoped — see `accessibleApplicationIds`.
      const appIds = await accessibleApplicationIds(ctx);
      if (appIds.length === 0) return { events: [] };
      const rows = await prisma.webhookEvent.findMany({
        where: {
          applicationId: { in: appIds },
          ...(provider ? { provider } : {}),
          ...(onlyFailed ? { processingError: { not: null } } : {}),
        },
        orderBy: { receivedAt: 'desc' },
        take: limit,
        include: { application: { select: { slug: true } } },
      });
      return {
        events: rows.map((r) => ({
          id: r.id,
          applicationSlug: r.application.slug,
          provider: r.provider,
          eventType: r.eventType,
          processedAt: r.processedAt?.toISOString() ?? null,
          processingError: r.processingError,
          receivedAt: r.receivedAt.toISOString(),
        })),
      };
    },
  },
  {
    name: 'recent_failed_webhook_deliveries',
    description:
      "Recent outbound webhook deliveries to the workspace's customer endpoints " +
      'that are currently FAILED. Surfaces customer endpoints that have stopped ' +
      'accepting your events.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
      },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const limit = clampLimit(args.limit);
      // Grant-scoped, not merely tenant-scoped — see `accessibleApplicationIds`.
      const appIds = await accessibleApplicationIds(ctx);
      if (appIds.length === 0) return { deliveries: [] };
      const rows = await prisma.webhookDelivery.findMany({
        where: {
          applicationId: { in: appIds },
          status: 'FAILED',
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          endpoint: { include: { application: { select: { slug: true } } } },
        },
      });
      return {
        deliveries: rows.map((r) => ({
          id: r.id,
          endpointId: r.endpointId,
          applicationSlug: r.endpoint.application.slug,
          url: r.endpoint.url,
          eventType: r.eventType,
          attempts: r.attempts,
          responseStatus: r.responseStatus,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  },
  {
    name: 'application_health',
    description:
      "Per-application snapshot of payment success rate (30d) and outbound webhook " +
      'success rate (24h). Sorted by failure count — the top row is the app to investigate first.',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const since24h = new Date(Date.now() - DAY_MS);
      const since30d = new Date(Date.now() - 30 * DAY_MS);
      const apps = await prisma.application.findMany({
        where: { id: { in: await accessibleApplicationIds(ctx) } },
        select: { id: true, slug: true, name: true },
      });
      if (apps.length === 0) return { applications: [] };
      const out = await Promise.all(
        apps.map(async (a) => {
          const [paySucceeded, payFailed, hookSucceeded, hookFailed] = await Promise.all([
            prisma.payment.count({
              where: { applicationId: a.id, status: 'SUCCEEDED', createdAt: { gte: since30d } },
            }),
            prisma.payment.count({
              where: { applicationId: a.id, status: 'FAILED', createdAt: { gte: since30d } },
            }),
            prisma.webhookDelivery.count({
              where: { applicationId: a.id, status: 'SUCCEEDED', createdAt: { gte: since24h } },
            }),
            prisma.webhookDelivery.count({
              where: { applicationId: a.id, status: 'FAILED', createdAt: { gte: since24h } },
            }),
          ]);
          const payDenom = paySucceeded + payFailed;
          const hookDenom = hookSucceeded + hookFailed;
          return {
            applicationId: a.id,
            applicationSlug: a.slug,
            applicationName: a.name,
            paymentsLast30d: { succeeded: paySucceeded, failed: payFailed, successRate: payDenom === 0 ? null : paySucceeded / payDenom },
            webhooksLast24h: { succeeded: hookSucceeded, failed: hookFailed, successRate: hookDenom === 0 ? null : hookSucceeded / hookDenom },
            totalFailures: payFailed + hookFailed,
          };
        }),
      );
      out.sort((a, b) => b.totalFailures - a.totalFailures);
      return { applications: out };
    },
  },
  {
    name: 'get_end_user',
    description:
      'Look up one end-user in an application by email OR id. Returns profile, role, ' +
      "verification state, the Application's environment, and their current subscription " +
      '(if any). Provide `applicationId` plus exactly one of `email` or `endUserId`. ' +
      'Read-only; no password or token data.',
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        email: { type: 'string' },
        endUserId: { type: 'string' },
      },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      // Scope to the Applications this operator may READ — not merely to the
      // workspace. Tenant scoping alone let an APP_VIEWER MEMBER granted one
      // Application read any other Application's end-users by passing its id,
      // which the REST end-user routes answer 404 for.
      //
      // A denied Application returns the same `application_not_found_in_workspace`
      // as one in another tenant, matching `ensureAppAccess`'s non-disclosure
      // posture: existence must not leak through the refusal.
      const readable = await accessibleApplicationIds(ctx);
      const app = readable.includes(String(args.applicationId))
        ? await prisma.application.findFirst({
            where: { id: String(args.applicationId), tenantId: ctx.tenantId },
            select: { id: true, environment: true },
          })
        : null;
      if (!app) {
        return { found: false, reason: 'application_not_found_in_workspace' };
      }
      const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : undefined;
      const endUserId = typeof args.endUserId === 'string' ? args.endUserId.trim() : undefined;
      if (!email && !endUserId) {
        return { found: false, reason: 'provide_email_or_endUserId' };
      }
      const user = email
        ? await prisma.endUser.findUnique({
            where: { applicationId_email: { applicationId: app.id, email } },
          })
        : await prisma.endUser.findFirst({
            where: { id: endUserId as string, applicationId: app.id },
          });
      if (!user) return { found: false };

      const subscription = await prisma.subscription.findFirst({
        where: {
          applicationId: app.id,
          endUserId: user.id,
          status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        },
        orderBy: { createdAt: 'desc' },
        include: { plan: { select: { slug: true, name: true } } },
      });

      return {
        found: true,
        endUser: {
          id: user.id,
          email: user.email,
          role: user.role,
          emailVerified: user.emailVerified,
          environment: app.environment,
          createdAt: user.createdAt.toISOString(),
        },
        currentSubscription: subscription
          ? {
              id: subscription.id,
              status: subscription.status,
              planSlug: subscription.plan?.slug ?? null,
              planName: subscription.plan?.name ?? null,
            }
          : null,
      };
    },
  },
];
