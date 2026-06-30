/**
 * Application service.
 *
 * An Application is one project under a Tenant. Every domain row in ReliPay
 * (EndUser, ApiKey, Subscription, WebhookEvent…) carries an `applicationId`.
 *
 * On create we mint:
 *   - a unique `slug` (URL-safe identifier, used inside keys),
 *   - a `publicKey` (browser-safe, embedded in `@relipay/react`),
 *   - sensible default `authConfig` and `billingConfig` from shared-types.
 *
 * Slugs are immutable. Renaming is fine; the slug stays.
 */

import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import { generatePublicKey } from '../../lib/keys.js';
import {
  AuthConfigSchema,
  BillingConfigSchema,
  type AuthConfig,
  type BillingConfig,
  type BillingProvider,
} from '@relipay/shared-types';
import { Prisma, type Application } from '@prisma/client';

export interface CreateApplicationInput {
  tenantId: string;
  name: string;
  slug: string;
  /**
   * Partial overrides for the default auth config. Each field is independently
   * optional — pass only what you want to change from the defaults.
   *
   * `| undefined` is explicit so `exactOptionalPropertyTypes` accepts the
   * shape Zod produces (where `optional()` means `T | undefined`).
   */
  authConfig?: {
    methods?: AuthConfig['methods'] | undefined;
    passwordMinLength?: number | undefined;
    redirectUrls?: string[] | undefined;
    organizationsEnabled?: boolean | undefined;
  };
  billingProvider?: BillingProvider | undefined;
  /**
   * Opt billing ON at create time. Defaults OFF — new apps start with the
   * billing surface gated (see `requireBillingEnabled`). Operators flip it on
   * later via Panel → Billing; super-admins can provision it on directly.
   */
  enableBilling?: boolean | undefined;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  methods: ['password'],
  passwordMinLength: 8,
  redirectUrls: [],
  organizationsEnabled: false,
  signupMode: 'public',
  signupEnabled: true,
  // End-user 2FA available but not forced by default.
  mfa: 'optional',
  // HIBP breach check is on by default — operators can opt out per app.
  passwordBreachCheckEnabled: true,
  // MCP server + OAuth AS off by default — operators opt in per app.
  mcpEnabled: false,
  // HS256 (per-app derived key) by default; RS256/JWKS is per-app opt-in.
  tokenAlg: 'HS256',
};

function defaultBillingConfig(provider: BillingProvider): BillingConfig {
  // Billing starts OFF for new apps — operators opt in per app. `create()`
  // overrides this when `enableBilling` is passed.
  return { enabled: false, dunningEnabled: false, provider, billingSubject: 'user', currency: 'USD', metadata: {} };
}

export const applicationsService = {
  async list(
    tenantId?: string,
    opts?: { take?: number; skip?: number; ids?: string[] },
  ): Promise<Application[]> {
    return prisma.application.findMany({
      ...((tenantId !== undefined || opts?.ids !== undefined) && {
        where: {
          ...(tenantId !== undefined && { tenantId }),
          // Per-app grant scoping (roadmap #8): a workspace MEMBER with
          // grants only sees the granted Applications.
          ...(opts?.ids !== undefined && { id: { in: opts.ids } }),
        },
      }),
      orderBy: { createdAt: 'desc' },
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
  },

  async get(id: string): Promise<Application> {
    const app = await prisma.application.findUnique({ where: { id } });
    if (!app) {
      throw new RelipayError({
        statusCode: 404,
        code: 'APPLICATION_NOT_FOUND',
        message: `Application "${id}" not found.`,
        fix: 'List applications with GET /api/v1/admin/applications.',
      });
    }
    return app;
  },

  async getBySlug(slug: string): Promise<Application> {
    const app = await prisma.application.findUnique({ where: { slug } });
    if (!app) {
      throw new RelipayError({
        statusCode: 404,
        code: 'APPLICATION_NOT_FOUND',
        message: `Application slug "${slug}" not found.`,
        fix: 'Slugs are case-sensitive. Check Panel → Applications.',
      });
    }
    return app;
  },

  async create(input: CreateApplicationInput): Promise<Application> {
    if (!SLUG_RE.test(input.slug)) {
      throw new RelipayError({
        statusCode: 400,
        code: 'APPLICATION_SLUG_INVALID',
        message: `Slug "${input.slug}" is not URL-safe.`,
        fix: 'Use lowercase letters, digits, and hyphens only. Must start and end with alphanumerics. Max 40 chars.',
      });
    }

    // Ensure parent tenant exists with a clear error rather than a Prisma FK failure.
    const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
    if (!tenant) {
      throw new RelipayError({
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
        message: `Tenant "${input.tenantId}" not found.`,
        fix: 'Create a tenant first with POST /api/v1/admin/tenants.',
      });
    }

    const authConfig = AuthConfigSchema.parse({
      ...DEFAULT_AUTH_CONFIG,
      ...input.authConfig,
    });
    const billingConfig = BillingConfigSchema.parse({
      ...defaultBillingConfig(input.billingProvider ?? 'stripe'),
      enabled: input.enableBilling ?? false,
    });

    try {
      // Wrap in a transaction so the default `user` role gets seeded
      // alongside the Application — the public sign-up flow needs it.
      return await prisma.$transaction(async (tx) => {
        const app = await tx.application.create({
          data: {
            tenantId: input.tenantId,
            name: input.name,
            slug: input.slug,
            publicKey: generatePublicKey(input.slug),
            // Cast — Prisma's InputJsonValue is structurally narrower than our
            // domain types (it disallows `unknown`-typed values in records),
            // but at runtime any JSON-serialisable object is accepted.
            authConfig: authConfig as object,
            billingConfig: billingConfig as object,
          },
        });
        await tx.endUserRole.create({
          data: {
            applicationId: app.id,
            name: 'user',
            description: 'Default role assigned to public sign-ups.',
            isDefault: true,
          },
        });
        return app;
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RelipayError({
          statusCode: 409,
          code: 'APPLICATION_SLUG_TAKEN',
          message: `An application with slug "${input.slug}" already exists.`,
          fix: 'Pick a different slug. Slugs are global across all tenants for now.',
        });
      }
      throw e;
    }
  },

  /**
   * Patch the application's authConfig (which methods are enabled, password
   * minimum length, redirect URLs). Whatever's not in `patch` is left alone.
   *
   * Disabling `password` is the way to make an app OAuth-only — the public
   * sign-in / sign-up endpoints check `methods.includes('password')` before
   * accepting a password attempt.
   */
  async updateAuthConfig(args: {
    applicationId: string;
    patch: {
      methods?: string[] | undefined;
      passwordMinLength?: number | undefined;
      redirectUrls?: string[] | undefined;
      organizationsEnabled?: boolean | undefined;
      signupEnabled?: boolean | undefined;
      signupMode?: 'public' | 'secret_only' | 'invite_only' | undefined;
      mfa?: 'off' | 'optional' | 'required' | undefined;
      mcpEnabled?: boolean | undefined;
      passwordBreachCheckEnabled?: boolean | undefined;
      /**
       * Access-token signature alg. `RS256` makes NEW access tokens
       * offline-verifiable against /.well-known/jwks.json; outstanding HS256
       * tokens keep verifying (the API accepts both). Default HS256.
       */
      tokenAlg?: 'HS256' | 'RS256' | undefined;
    };
  }): Promise<Application> {
    const app = await this.get(args.applicationId);
    const current = AuthConfigSchema.parse(app.authConfig);
    const cleaned: Record<string, unknown> = Object.fromEntries(
      Object.entries(args.patch).filter(([, v]) => v !== undefined),
    );
    // `current` always carries BOTH signup fields (the schema transform fills
    // them in), so a legacy patch that sends only `signupEnabled` would lose to
    // `current.signupMode` in the merge below. Translate the legacy boolean to
    // an explicit `signupMode` and drop it, so whichever the caller actually
    // set wins. `signupMode` in the patch always takes precedence.
    if (cleaned.signupMode === undefined && cleaned.signupEnabled !== undefined) {
      cleaned.signupMode = cleaned.signupEnabled === false ? 'invite_only' : 'public';
    }
    delete cleaned.signupEnabled;
    const next = AuthConfigSchema.parse({ ...current, ...cleaned });
    return prisma.application.update({
      where: { id: args.applicationId },
      data: { authConfig: next as object },
    });
  },

  /**
   * Patch the application's billingConfig — currently the `enabled` master
   * switch. Off (default for new apps) gates the public billing API + hides the
   * Billing group in the panel.
   */
  async updateBillingConfig(args: {
    applicationId: string;
    patch: {
      enabled?: boolean | undefined;
      dunningEnabled?: boolean | undefined;
      billingSubject?: 'user' | 'org' | undefined;
      // string sets the free-tier default plan slug; null clears it.
      defaultPlanSlug?: string | null | undefined;
    };
  }): Promise<Application> {
    const app = await this.get(args.applicationId);
    const current = BillingConfigSchema.parse(app.billingConfig);
    const cleaned = Object.fromEntries(
      Object.entries(args.patch).filter(([, v]) => v !== undefined),
    );
    const merged: Record<string, unknown> = { ...current, ...cleaned };
    // Explicit null clears the optional free-tier default.
    if (cleaned.defaultPlanSlug === null) delete merged.defaultPlanSlug;
    const next = BillingConfigSchema.parse(merged);
    return prisma.application.update({
      where: { id: args.applicationId },
      data: { billingConfig: next as object },
    });
  },

  /**
   * Patch the hosted-portal config (Portal V2): the opt-in master switch and
   * branding. Custom-domain binding + DNS verification is a separate (phase-2)
   * flow, so it's not patched here. Toggling `enabled` auto-allows the hosted
   * portal origin for this app's publishable key (see lib/portal-origins).
   */
  async updatePortalConfig(args: {
    applicationId: string;
    enabled?: boolean | undefined;
    branding?: Record<string, unknown> | undefined;
    /** Custom portal domain, or null to clear it. Setting/changing it resets verification. */
    portalDomain?: string | null | undefined;
  }): Promise<Application> {
    const app = await this.get(args.applicationId); // 404s on a bad id
    // Changing the domain invalidates any prior verification.
    const domainChanged =
      args.portalDomain !== undefined && args.portalDomain !== app.portalDomain;
    return prisma.application.update({
      where: { id: args.applicationId },
      data: {
        ...(args.enabled !== undefined && { hostedPortalEnabled: args.enabled }),
        ...(args.branding !== undefined && { portalBranding: args.branding as object }),
        ...(args.portalDomain !== undefined && {
          portalDomain: args.portalDomain || null,
        }),
        ...(domainChanged && { portalDomainVerifiedAt: null }),
      },
    });
  },

  /**
   * Per-app session kill-switch ("log everyone out now"). Atomically:
   *   1. bumps `tokenGeneration` — every live end-user access / MFA-challenge
   *      token instantly fails verification (they were signed with a key
   *      derived from the OLD generation, see lib/jwt.ts), and
   *   2. revokes every active refresh token for the app — so no client can
   *      mint a fresh access token off a still-valid refresh.
   *
   * Both in one transaction: a half-applied rotation (generation bumped but
   * refresh tokens still live) would let clients refresh straight back in,
   * defeating the switch.
   */
  async rotateSessions(
    applicationId: string,
  ): Promise<{ tokenGeneration: number; sessionsRevoked: number }> {
    return prisma.$transaction(async (tx) => {
      const app = await tx.application.update({
        where: { id: applicationId },
        data: { tokenGeneration: { increment: 1 } },
        select: { tokenGeneration: true },
      });
      const revoked = await tx.refreshToken.updateMany({
        where: { applicationId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { tokenGeneration: app.tokenGeneration, sessionsRevoked: revoked.count };
    });
  },

  /**
   * Rotate the Application's publishable key (`rp_pub_*`) with a grace window.
   *
   * Unlike a secret key (server-side, rotate instantly), the publishable key is
   * baked into shipped client bundles you cannot force-update — old app
   * versions, cached SPAs, desktop installs. So rotation is **dual-key**: the
   * current key moves to `previousPublicKey` with a `validUntil` deadline, a
   * fresh key is minted, and BOTH verify (see `requirePublishableOrSecretKey`)
   * until the deadline passes. Roll the new key out to clients during the
   * window, then the old one hard-expires.
   *
   * The slug is preserved in the new key (`rp_pub_<slug>_<random>`) — rotation
   * changes only the random tail, so a leaked key stays identifiable.
   *
   * There is only ONE previous-key slot. Rotating again while a previous key is
   * still inside its grace window would silently drop that previous key, locking
   * out clients still on it. So a second rotation during an active grace window
   * is **rejected** (409 `PUBLIC_KEY_ROTATION_IN_GRACE`) unless `force` is set —
   * `force` is the leaked-key path, where you intentionally accept that the
   * older key dies now.
   *
   * @param graceDays Days the old key stays valid. Clamped to [1, 90], default 30.
   * @param force Rotate even if a previous key is still in its grace window (drops it).
   */
  async rotatePublicKey(args: {
    applicationId: string;
    graceDays?: number | undefined;
    force?: boolean | undefined;
  }): Promise<Application> {
    const graceDays = Math.min(Math.max(Math.floor(args.graceDays ?? 30), 1), 90);
    const app = await this.get(args.applicationId);
    if (
      !args.force &&
      app.previousPublicKeyValidUntil &&
      app.previousPublicKeyValidUntil > new Date()
    ) {
      throw new RelipayError({
        statusCode: 409,
        code: 'PUBLIC_KEY_ROTATION_IN_GRACE',
        message: `A previous publishable key is still in its grace window until ${app.previousPublicKeyValidUntil.toISOString()}. Rotating again would drop it and lock out clients still using it.`,
        fix: 'Wait for the grace window to end, or rotate with force=true to drop the previous key now (use this only for a leaked key).',
      });
    }
    const validUntil = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000);
    return prisma.application.update({
      where: { id: args.applicationId },
      data: {
        publicKey: generatePublicKey(app.slug),
        previousPublicKey: app.publicKey,
        previousPublicKeyValidUntil: validUntil,
      },
    });
  },

  /**
   * Aggregate dashboard stats for one application: end-user totals + a 30-day
   * sign-up trend, a security-events summary, a billing snapshot, and a
   * usage/credits roll-up. Powers the per-app Overview tiles. All counts are
   * scoped to `applicationId`; no cross-application leakage.
   */
  async stats(applicationId: string): Promise<ApplicationStats> {
    // Confirm the app exists (404s with a clear error rather than returning
    // an all-zero card for a typo'd id).
    const app = await this.get(applicationId);
    const billingConfig = BillingConfigSchema.parse(app.billingConfig);

    const now = Date.now();
    const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);
    // Trend window: 30 calendar days inclusive of today.
    const TREND_DAYS = 30;
    const trendStart = new Date(now - (TREND_DAYS - 1) * 24 * 60 * 60 * 1000);
    trendStart.setUTCHours(0, 0, 0, 0);

    const [
      usersTotal,
      usersVerified,
      newLast7d,
      newLast30d,
      eventsLast30d,
      signInsLast30d,
      signUpsLast30d,
      activeSubscriptions,
      plansActive,
      plansTotal,
      creditsAgg,
      usageAgg,
      trendRows,
    ] = await Promise.all([
      prisma.endUser.count({ where: { applicationId } }),
      prisma.endUser.count({ where: { applicationId, emailVerified: true } }),
      prisma.endUser.count({ where: { applicationId, createdAt: { gte: since7d } } }),
      prisma.endUser.count({ where: { applicationId, createdAt: { gte: since30d } } }),
      prisma.securityEvent.count({ where: { applicationId, createdAt: { gte: since30d } } }),
      prisma.securityEvent.count({
        where: { applicationId, type: 'user.signed_in', createdAt: { gte: since30d } },
      }),
      prisma.securityEvent.count({
        where: { applicationId, type: 'user.signed_up', createdAt: { gte: since30d } },
      }),
      prisma.subscription.count({ where: { applicationId, status: 'ACTIVE' } }),
      prisma.plan.count({ where: { applicationId, active: true } }),
      prisma.plan.count({ where: { applicationId } }),
      prisma.creditBalance.aggregate({ where: { applicationId }, _sum: { balance: true } }),
      prisma.usageRecord.aggregate({
        where: { meter: { applicationId }, occurredAt: { gte: since30d } },
        _sum: { quantity: true },
      }),
      prisma.$queryRaw<Array<{ day: Date; count: bigint }>>(Prisma.sql`
        SELECT date_trunc('day', "created_at") AS day, count(*) AS count
        FROM "end_users"
        WHERE "application_id" = ${applicationId} AND "created_at" >= ${trendStart}
        GROUP BY day
        ORDER BY day ASC
      `),
    ]);

    // Densify the trend to one entry per day so the panel renders a gap-free
    // sparkline (days with no sign-ups become explicit zeroes).
    const byDay = new Map<string, number>();
    for (const r of trendRows) {
      byDay.set(new Date(r.day).toISOString().slice(0, 10), Number(r.count));
    }
    const signupTrend: Array<{ date: string; count: number }> = [];
    for (let i = 0; i < TREND_DAYS; i++) {
      const d = new Date(trendStart.getTime() + i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      signupTrend.push({ date: key, count: byDay.get(key) ?? 0 });
    }

    return {
      users: {
        total: usersTotal,
        verified: usersVerified,
        newLast7d,
        newLast30d,
        signupTrend,
      },
      security: {
        eventsLast30d,
        signInsLast30d,
        signUpsLast30d,
      },
      billing: {
        enabled: billingConfig.enabled,
        activeSubscriptions,
        plansActive,
        plansTotal,
      },
      usage: {
        creditsOutstanding: creditsAgg._sum.balance ?? 0,
        usageLast30d: usageAgg._sum.quantity ?? 0,
      },
    };
  },
};

export interface ApplicationStats {
  users: {
    total: number;
    verified: number;
    newLast7d: number;
    newLast30d: number;
    /** One entry per day for the last 30 days (oldest first), gap-filled. */
    signupTrend: Array<{ date: string; count: number }>;
  };
  security: {
    eventsLast30d: number;
    signInsLast30d: number;
    signUpsLast30d: number;
  };
  billing: {
    enabled: boolean;
    activeSubscriptions: number;
    plansActive: number;
    plansTotal: number;
  };
  usage: {
    creditsOutstanding: number;
    usageLast30d: number;
  };
}
