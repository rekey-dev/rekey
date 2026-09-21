/**
 * Application service.
 *
 * An Application is one project under a Tenant. Every domain row in Rekey
 * (EndUser, ApiKey, Subscription, WebhookEvent…) carries an `applicationId`.
 *
 * On create we mint:
 *   - a unique `slug` (URL-safe identifier, used inside keys),
 *   - a `publicKey` (browser-safe, embedded in `@rekey.dev/react`),
 *   - sensible default `authConfig` and `billingConfig` from shared-types.
 *
 * Slugs are immutable. Renaming is fine; the slug stays.
 */

import { prisma } from '../../lib/prisma.js';
import { cachedDashboard, forgetDashboard } from '../../lib/dashboard-cache.js';
import { RekeyError } from '../../lib/error.js';
import { emailService, lockEmailCoupling } from '../email/email.service.js';
import { organizationRolesService } from '../organization-roles/organization-roles.service.js';
import { generatePublicKey } from '../../lib/keys.js';
import { assertProductionAppQuota } from '../../lib/tenant-limits.js';
import {
  AuthConfigSchema,
  BillingConfigSchema,
  type AuthConfig,
  type BillingConfig,
  type BillingProvider,
} from '@rekey.dev/shared-types';
import { Prisma, type AppEnvironment, type Application } from '@prisma/client';

export interface CreateApplicationInput {
  tenantId: string;
  name: string;
  slug: string;
  /**
   * Partial overrides for the default auth config. Each field is independently
   * optional, pass only what you want to change from the defaults.
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
   * Which environment this Application is. Defaults to DEVELOPMENT, going
   * live is a deliberate act. It does not restrict which billing credentials
   * the Application may hold; it drives the API-key prefix and is the unit
   * deployments are billed and quota'd by.
   *
   * Creating it PRODUCTION consumes a production slot immediately. Creating it
   * DEVELOPMENT or STAGING costs nothing and is reversible in one direction:
   * `promote` moves it to PRODUCTION later, asserting the same quota. There is
   * no path back down. See the note on `AppEnvironment` in schema.prisma.
   */
  environment?: AppEnvironment | undefined;
  /**
   * Opt billing ON at create time. Defaults OFF, new apps start with the
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
  // HIBP breach check is on by default, operators can opt out per app.
  passwordBreachCheckEnabled: true,
  // New accounts get their confirmation link automatically; enforcing that
  // they click it is a separate, opt-in decision.
  sendVerificationEmailOnSignUp: true,
  requireEmailVerification: false,
  // MCP server + OAuth AS off by default, operators opt in per app.
  mcpEnabled: false,
  // OpenID Provider off by default. Turning an Application into an IdP puts a
  // public authentication surface on the internet; that is an explicit choice.
  oidcEnabled: false,
  // RFC 7591 open registration ON, because MCP clients self-register as their
  // first act and nothing else can create an OAuth client yet. It is the
  // control an operator hardens with once their relying parties exist, not a
  // default that would brick both surfaces the day they enable them.
  dynamicClientRegistration: true,
  // HS256 (per-app derived key) by default; RS256/JWKS is per-app opt-in.
  tokenAlg: 'HS256',
  // Devices are recorded when a client identifies itself and never demanded;
  // requiring a binding is a per-app decision for native clients only.
  deviceBinding: 'optional',
};

function defaultBillingConfig(provider: BillingProvider): BillingConfig {
  // Billing starts OFF for new apps, operators opt in per app. `create()`
  // overrides this when `enableBilling` is passed.
  return {
    enabled: false,
    dunningEnabled: false,
    provider,
    billingSubject: 'user',
    trialPolicy: 'once_per_application',
    currency: 'USD',
    metadata: {},
  };
}

/**
 * The filter `list` and `count` share.
 *
 * Deliberately one function used by both: a `count` taken over a slightly
 * different `where` than the rows is worse than no count at all, because the
 * caller then pages off the end of a list the server told it was longer.
 */
function listWhere(tenantId?: string, ids?: string[]): Prisma.ApplicationWhereInput {
  return {
    ...(tenantId !== undefined && { tenantId }),
    // Per-app grant scoping (roadmap #8): a workspace MEMBER with
    // grants only sees the granted Applications.
    ...(ids !== undefined && { id: { in: ids } }),
  };
}

// Lifecycle helpers (promote / disable / enable)

/**
 * The same 404 from every lifecycle path, worded the same way.
 *
 * Route handlers reach these methods through `ensureAppAccess`, which has
 * already proved the Application exists in the caller's workspace and returns
 * its own non-disclosing 404 when it does not. So this fires only on a genuine
 * race (deleted between the check and the act) or an admin-key caller. It
 * keeps the same code as `ensureAppAccess` so a client switching on `code`
 * sees one answer to "no such application", not two.
 */
function applicationNotFound(applicationId: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'APPLICATION_NOT_FOUND',
    message: `Application "${applicationId}" not found.`,
    fix: 'List applications with GET /api/v1/tenant/applications.',
  });
}

/**
 * 409 for "you cannot promote a frozen application", from both the pre-lock
 * check and the lost-race path. One function so the two cannot drift: they
 * describe the same state and an operator hitting either has the same next
 * step.
 */
function applicationDisabledForPromote(slug: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'APPLICATION_DISABLED',
    message: `Application "${slug}" is disabled and cannot be promoted.`,
    fix: 'Enable the application first, then promote it. Promoting it while disabled would consume a production slot for an application that serves no traffic.',
  });
}

/** 409 for "this is already production", from both the pre-check and the lost-race path. */
function alreadyPromoted(slug: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'ALREADY_PROMOTED',
    message: `Application "${slug}" is already in the production environment.`,
    fix: 'Promotion is one-way and happens once. There is nothing further to do, and there is no way to move an application back out of production.',
  });
}

/**
 * Postgres advisory lock namespace for workspace production-slot arbitration.
 * Arbitrary, and only has to stay distinct from any other advisory-lock user
 * this codebase grows. Nothing else takes an advisory lock today.
 */
const SLOT_LOCK_NAMESPACE = 4711;

/**
 * Serialise everything that consumes a production slot within one workspace.
 *
 * Transaction-scoped, so it releases on commit and on rollback alike and
 * cannot be leaked by a throw between here and the end of the transaction.
 * `hashtext` maps the cuid tenant id into the int4 the two-argument form
 * wants; a hash collision between two workspaces costs one of them a brief
 * wait on a lock it did not need, and nothing else.
 *
 * Both `promote` and `enable` must take this. A lock only one door takes
 * serialises nothing.
 */
async function lockWorkspaceSlots(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SLOT_LOCK_NAMESPACE}::int, hashtext(${tenantId}))`;
}

export const applicationsService = {
  async list(
    tenantId?: string,
    opts?: { take?: number; skip?: number; ids?: string[] },
  ): Promise<Application[]> {
    return prisma.application.findMany({
      where: listWhere(tenantId, opts?.ids),
      orderBy: { createdAt: 'desc' },
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
  },

  /** Total Applications matching `list`'s filter, ignoring take/skip. */
  async count(tenantId?: string, opts?: { ids?: string[] }): Promise<number> {
    return prisma.application.count({ where: listWhere(tenantId, opts?.ids) });
  },

  /**
   * Fetch one Application by id.
   *
   * Pass `scope.tenantId` on every tenant-surface call: it folds the
   * ownership check into the query, so an id belonging to another tenant
   * 404s identically to a missing id (no cross-tenant existence oracle) even
   * if the caller forgot its `ensureAppAccess`. The bare form exists for the
   * super-admin surface and system-internal callers (webhook pipeline, plan
   * registration) that operate on system-derived ids. This parameter exists
   * because an unscoped `get` on the tenant surface already caused one real
   * cross-tenant bug: the guard should live in the query, not in caller
   * discipline.
   */
  async get(id: string, scope?: { tenantId: string }): Promise<Application> {
    const app = scope?.tenantId
      ? await prisma.application.findFirst({ where: { id, tenantId: scope.tenantId } })
      : await prisma.application.findUnique({ where: { id } });
    if (!app) {
      throw new RekeyError({
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
      throw new RekeyError({
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
      throw new RekeyError({
        statusCode: 400,
        code: 'APPLICATION_SLUG_INVALID',
        message: `Slug "${input.slug}" is not URL-safe.`,
        fix: 'Use lowercase letters, digits, and hyphens only. Must start and end with alphanumerics. Max 40 chars.',
      });
    }

    // Ensure parent tenant exists with a clear error rather than a Prisma FK failure.
    const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
    if (!tenant) {
      throw new RekeyError({
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
      // alongside the Application, the public sign-up flow needs it.
      return await prisma.$transaction(async (tx) => {
        // Only production applications consume quota. Checked inside the
        // transaction so the count and the create read the same snapshot, and
        // only when the caller asked for PRODUCTION, the column defaults to
        // DEVELOPMENT, so an omitted `environment` is never billable and must
        // not be blocked.
        //
        // The lock is the SAME one `promote` and `enable` take, and it has to
        // be. There are three doors into the production count and a lock that
        // only two of them take serialises nothing: two concurrent creates
        // would race each other, and a create would race a promote, either way
        // overshooting a ceiling that has no demote and no delete to correct
        // it. This was missed when promotion was added, because the lock was
        // reasoned about as "the thing promotion needs" rather than as the
        // thing the COUNT needs.
        //
        // Taken only on the PRODUCTION branch, so ordinary application
        // creation, the overwhelmingly common case, and the one that runs
        // during onboarding, is never serialised behind a workspace lock.
        if (input.environment === 'PRODUCTION') {
          await lockWorkspaceSlots(tx, input.tenantId);
          await assertProductionAppQuota(input.tenantId, 'create', tx);
        }
        const app = await tx.application.create({
          data: {
            tenantId: input.tenantId,
            name: input.name,
            slug: input.slug,
            publicKey: generatePublicKey(input.slug),
            ...(input.environment !== undefined && { environment: input.environment }),
            // Cast, Prisma's InputJsonValue is structurally narrower than our
            // domain types (it disallows `unknown`-typed values in records),
            // but at runtime any JSON-serialisable object is accepted.
            authConfig: authConfig as object,
            billingConfig: billingConfig as object,
          },
        });
        await tx.applicationRole.create({
          data: {
            applicationId: app.id,
            name: 'user',
            description: 'Default role assigned to public sign-ups.',
            isDefault: true,
          },
        });
        // Organization roles are seeded even when `organizationsEnabled` is
        // false. The toggle gates org CREATION, not the vocabulary, and seeding
        // here means flipping it on later never lands an operator on an
        // Application whose memberships reference names no catalog defines.
        await organizationRolesService.seedBuiltIns(tx, app.id);
        return app;
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RekeyError({
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
   * Disabling `password` is the way to make an app OAuth-only, the public
   * sign-in / sign-up endpoints check `methods.includes('password')` before
   * accepting a password attempt.
   */
  async updateAuthConfig(args: {
    applicationId: string;
    patch: {
      methods?: string[] | undefined;
      passwordMinLength?: number | undefined;
      redirectUrls?: string[] | undefined;
      /**
       * Base URL emails link back to. `null` (or `''`) CLEARS it, that is a
       * meaningful operation, not a no-op: with no app URL the templates drop
       * their call-to-action button rather than render a dead one.
       */
      appUrl?: string | null | undefined;
      /**
       * Where to send the browser for the sign-in half of this Application's
       * own OIDC authorize flow. `null` (or `''`) CLEARS it, which is how an
       * operator turns the delegation back off and gets the built-in page back.
       */
      hostedAuthorizeUrl?: string | null | undefined;
      organizationsEnabled?: boolean | undefined;
      signupEnabled?: boolean | undefined;
      signupMode?: 'public' | 'secret_only' | 'invite_only' | undefined;
      mfa?: 'off' | 'optional' | 'required' | undefined;
      mcpEnabled?: boolean | undefined;
      /**
       * Turn the Application into an OpenID Provider, discovery document,
       * `id_token`, `/oauth/userinfo`. Independent of `mcpEnabled`; see
       * docs/oidc-provider.md.
       */
      oidcEnabled?: boolean | undefined;
      passwordBreachCheckEnabled?: boolean | undefined;
      sendVerificationEmailOnSignUp?: boolean | undefined;
      /**
       * Refuse password sign-in for users with `emailVerified: false`. Turning
       * it on takes effect immediately for existing accounts, anyone who
       * never confirmed their address is locked out until they do.
       */
      requireEmailVerification?: boolean | undefined;
      /**
       * Access-token signature alg. `RS256` makes NEW access tokens
       * offline-verifiable against /.well-known/jwks.json; outstanding HS256
       * tokens keep verifying (the API accepts both). Default HS256.
       */
      tokenAlg?: 'HS256' | 'RS256' | undefined;
    };
  }): Promise<Application> {
    // Outside the transaction: only for the 404, never for a decision.
    await this.get(args.applicationId);
    return prisma.$transaction(async (tx) => {
      // The same row lock the email switches take, then the config re-read
      // under it, so the coupling check below cannot pass against a value a
      // concurrent "email off" is about to change. See `lockEmailCoupling`.
      await lockEmailCoupling(tx, args.applicationId);
      const app = await tx.application.findUniqueOrThrow({ where: { id: args.applicationId } });
      const current = AuthConfigSchema.parse(app.authConfig);

      // The email coupling, read from the auth-config end.
      //
      // `emailService.setEventEnabled` already refuses to switch OFF an email
      // that the live auth config depends on. On its own that guarantee is
      // one-directional and walked around in three ordinary steps: turn
      // `requireEmailVerification` off, disable the now-permitted
      // `email_verification` email, turn verification back on. Every subsequent
      // sign-up is then stranded forever on a screen waiting for a mail nothing
      // will send, and nothing anywhere reports it.
      //
      // It lives HERE, not on the REST route, because the operator MCP tool
      // (`update_auth_config`) calls this service directly, a route-level check
      // would close one door and leave the other open.
      //
      // Only evaluated when the patch actually touches one of the two coupled
      // fields, and then against the MERGED config. Both halves matter: skipping
      // it for unrelated patches means an Application that somehow reached the
      // bad state can still be edited (and repaired) rather than frozen, and
      // reading the merged config means a patch that sets one half while the
      // other is already true is still caught.
      if (args.patch.methods !== undefined || args.patch.requireEmailVerification !== undefined) {
        const blockers = await emailService.authConfigBlockers(args.applicationId, {
          methods: args.patch.methods ?? current.methods,
          requireEmailVerification:
            args.patch.requireEmailVerification ?? current.requireEmailVerification,
        }, tx);
        if (blockers.length > 0) {
          // The master switch off is one cause with one remedy; a fix that
          // named the per-event switches would send the operator to toggles
          // that are already on.
          const masterOff = blockers.some((x) => x.cause === 'master_switch');
          throw new RekeyError({
            statusCode: 409,
            code: 'EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG',
            message: masterOff
              ? `All email is switched off for this Application. ${blockers.map((x) => x.message).join(' ')}`
              : blockers.map((x) => x.message).join(' '),
            fix: masterOff
              ? 'Turn email back on for this Application under Email → Send control first, then make this change.'
              : `Turn ${blockers
                  .map((x) => `"${x.eventKey}"`)
                  .join(' and ')} back on under Email → Templates first, then make this change.`,
          });
        }
      }
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
      // `appUrl` is the one optional field with no default, so clearing it has
      // to be expressible. `null`/`''` means "unset", drop the key from the
      // merged object rather than feeding a non-URL to the schema, which would
      // reject it and leave the operator unable to remove a stale URL.
      const clearAppUrl = cleaned.appUrl === null || cleaned.appUrl === '';
      if (clearAppUrl) delete cleaned.appUrl;
      // Same treatment, same reason: `hostedAuthorizeUrl` has no default, so
      // clearing it must be expressible and must not reach the schema as a
      // non-URL, which would reject the whole patch and strand the operator with
      // a delegation they cannot switch off.
      const clearHostedAuthorize =
        cleaned.hostedAuthorizeUrl === null || cleaned.hostedAuthorizeUrl === '';
      if (clearHostedAuthorize) delete cleaned.hostedAuthorizeUrl;
      const merged: Record<string, unknown> = { ...current, ...cleaned };
      if (clearAppUrl) delete merged.appUrl;
      if (clearHostedAuthorize) delete merged.hostedAuthorizeUrl;
      const next = AuthConfigSchema.parse(merged);
      return tx.application.update({
        where: { id: args.applicationId },
        data: { authConfig: next as object },
      });
    });
  },

  /**
   * Patch the application's billingConfig, currently the `enabled` master
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
    const updated = await prisma.application.update({
      where: { id: args.applicationId },
      data: { billingConfig: next as object },
    });
    // The overview tile shows `billing.enabled`; do not let it lag the toggle.
    forgetDashboard(statsCacheKey(args.applicationId));
    return updated;
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
   *   1. bumps `tokenGeneration`, every live end-user access / MFA-challenge
   *      token instantly fails verification (they were signed with a key
   *      derived from the OLD generation, see lib/jwt.ts), and
   *   2. revokes every active refresh token for the app, so no client can
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
   * baked into shipped client bundles you cannot force-update, old app
   * versions, cached SPAs, desktop installs. So rotation is **dual-key**: the
   * current key moves to `previousPublicKey` with a `validUntil` deadline, a
   * fresh key is minted, and BOTH verify (see `requirePublishableOrSecretKey`)
   * until the deadline passes. Roll the new key out to clients during the
   * window, then the old one hard-expires.
   *
   * The slug is preserved in the new key (`rp_pub_<slug>_<random>`), rotation
   * changes only the random tail, so a leaked key stays identifiable.
   *
   * There is only ONE previous-key slot. Rotating again while a previous key is
   * still inside its grace window would silently drop that previous key, locking
   * out clients still on it. So a second rotation during an active grace window
   * is **rejected** (409 `PUBLIC_KEY_ROTATION_IN_GRACE`) unless `force` is set,
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
      throw new RekeyError({
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
   * Promote a DEVELOPMENT or STAGING Application into PRODUCTION.
   *
   * The one permitted mutation of `environment`, and the only code path that
   * writes it after create. PRODUCTION is terminal: there is no demote, and no
   * caller may ask for one.
   *
   * Consumes a production slot, so it asserts `maxProductionApps` exactly as
   * `create` does. Refuses a disabled Application rather than promoting it into
   * a frozen state: that would spend a slot on something serving no traffic,
   * and re-enabling first costs nothing.
   *
   * **Touches no API keys.** Every key minted before this call keeps its
   * `rp_test_` prefix and keeps working, the prefix is a label for the human
   * pasting it, not a capability, and `requireApiKey` accepts both forms
   * identically (see middleware/api-key-auth.ts). Revoking them here would
   * break the customer's integration at the exact moment they went live, which
   * is the worst available timing. The panel prompts for a rotation instead.
   *
   * @param actorId TenantUser who promoted, for the audit breadcrumb. Null for
   *                admin-key and system callers, which have no TenantUser.
   */
  async promote(applicationId: string, actorId?: string | null): Promise<Application> {
    return prisma.$transaction(async (tx) => {
      const app = await tx.application.findUnique({
        where: { id: applicationId },
        select: { id: true, tenantId: true, environment: true, disabledAt: true, slug: true },
      });
      if (!app) throw applicationNotFound(applicationId);

      if (app.disabledAt !== null) throw applicationDisabledForPromote(app.slug);
      if (app.environment === 'PRODUCTION') {
        throw alreadyPromoted(app.slug);
      }

      // Serialise promotion and re-enable per workspace.
      //
      // This is the first raw SQL in apps/api, so it owes an explanation. The
      // quota check is check-then-act, and lib/tenant-limits.ts argues at
      // length that a small overshoot under concurrency is acceptable. That
      // argument was written for end-user sign-ups, where an overshoot
      // self-corrects on the next request. It does not transfer here: two
      // promotions racing the last slot both succeed, and because there is no
      // demote, the workspace is left permanently over its ceiling with no
      // mechanism that ever brings it back. The payoff for winning that race
      // deliberately is a free production slot forever, so "rare" is not a
      // defence.
      //
      // The objection tenant-limits raises to locking, that it would
      // serialise the hottest write path in the product, does not apply.
      // Promotion happens a handful of times per workspace ever. Nothing on a
      // request-serving path takes this lock; the only contenders are two
      // operators clicking the same button, which is exactly the case being
      // closed.
      //
      // Transaction-scoped (`_xact_`), so it releases on commit OR rollback and
      // cannot be leaked by a throw. The 4711 namespace keeps the key space
      // distinct from any future advisory-lock user.
      await lockWorkspaceSlots(tx, app.tenantId);
      await assertProductionAppQuota(app.tenantId, 'promote', tx);

      // Conditional update, not a plain one. Belt and braces behind the lock:
      // if the guard above is ever reordered or the lock is ever dropped, a
      // second promotion of the SAME row still cannot double-write, because
      // the predicate no longer matches. A zero count means someone else won
      // the race, which is a 409, not a crash.
      //
      // `disabledAt: null` is in the predicate, not just in the 409 check
      // above. That check reads the row BEFORE the lock is taken, so a
      // `disable` committing in between would otherwise leave this update
      // promoting an Application the endpoint explicitly refuses to promote,
      // PRODUCTION and frozen. No quota invariant breaks (a disabled app holds
      // no slot and `enable` re-asserts), but it is a state we say cannot
      // happen, and saying so is worth nothing if the write does not enforce
      // it. Both preconditions now hold at the moment of the write, not at the
      // moment they were read.
      const updated = await tx.application.updateMany({
        where: { id: applicationId, environment: { not: 'PRODUCTION' }, disabledAt: null },
        data: {
          environment: 'PRODUCTION',
          promotedAt: new Date(),
          promotedBy: actorId ?? null,
        },
      });
      if (updated.count === 0) {
        // Two predicates can miss, so the error has to say which one did.
        // Re-read rather than assume: reporting ALREADY_PROMOTED to an operator
        // whose application was disabled underneath them sends them looking for
        // a promotion that never happened.
        const now = await tx.application.findUnique({
          where: { id: applicationId },
          select: { environment: true, disabledAt: true },
        });
        if (now?.disabledAt != null) throw applicationDisabledForPromote(app.slug);
        throw alreadyPromoted(app.slug);
      }

      return tx.application.findUniqueOrThrow({ where: { id: applicationId } });
    });
  },

  /**
   * Freeze an Application. Rekey has no Application delete; this is what
   * stands in for one.
   *
   * **Never fails on quota, and never fails on state.** It frees a production
   * slot rather than consuming one, and a freeze an operator can be refused is
   * not a freeze, this is the button people reach for precisely when an
   * Application is already misbehaving. Disabling an already-disabled
   * Application is a no-op that returns the row unchanged, including its
   * original `disabledAt` and reason: the first freeze is the one that
   * happened, and a retried request must not rewrite that history.
   *
   * Deliberately does NOT bump `tokenGeneration`. Revoking every end-user
   * session would make the freeze partly irreversible, the thaw could not
   * give those sessions back, and reversibility is the entire feature.
   * End-user tokens stop working anyway, because both API-key middlewares
   * refuse the Application at the door.
   */
  async disable(
    applicationId: string,
    opts?: { reason?: string | undefined; actorId?: string | null | undefined },
  ): Promise<Application> {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { id: true, disabledAt: true },
    });
    if (!app) throw applicationNotFound(applicationId);
    if (app.disabledAt !== null) {
      return prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    }

    // Conditional: two concurrent disables must not have the second overwrite
    // the first one's timestamp, reason and actor.
    await prisma.application.updateMany({
      where: { id: applicationId, disabledAt: null },
      data: {
        disabledAt: new Date(),
        disabledBy: opts?.actorId ?? null,
        disabledReason: opts?.reason ?? null,
      },
    });
    return prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
  },

  /**
   * Thaw a disabled Application.
   *
   * The asymmetric half of the pair, and the one that can be refused. A
   * disabled PRODUCTION Application does not count against
   * `maxProductionApps`, that is what makes `disable` a usable substitute for
   * the delete Rekey does not have, so re-enabling one CONSUMES a slot and
   * must assert the quota. Without that assert, disable-then-enable would
   * launder an unlimited number of running production Applications past the
   * ceiling, and the ceiling would mean nothing.
   *
   * DEVELOPMENT and STAGING Applications are never counted, so they always
   * enable.
   *
   * Idempotent on an already-enabled Application: it is in the requested state,
   * and no quota is charged for a slot it already holds.
   */
  async enable(applicationId: string): Promise<Application> {
    return prisma.$transaction(async (tx) => {
      const app = await tx.application.findUnique({
        where: { id: applicationId },
        select: { id: true, tenantId: true, environment: true, disabledAt: true },
      });
      if (!app) throw applicationNotFound(applicationId);
      if (app.disabledAt === null) {
        return tx.application.findUniqueOrThrow({ where: { id: applicationId } });
      }

      if (app.environment === 'PRODUCTION') {
        // Same lock as `promote`, and it must be the same lock: promote and
        // enable are two doors into one count, and a lock that only one of
        // them takes serialises nothing.
        await lockWorkspaceSlots(tx, app.tenantId);
        await assertProductionAppQuota(app.tenantId, 'enable', tx);
      }

      await tx.application.updateMany({
        where: { id: applicationId, disabledAt: { not: null } },
        data: { disabledAt: null, disabledBy: null, disabledReason: null },
      });
      return tx.application.findUniqueOrThrow({ where: { id: applicationId } });
    });
  },

  /**
   * Overview-tile stats for one Application.
   *
   * The caller has already run `ensureAppAccess`, which 404s an unknown id, so
   * the application is not re-read to prove it exists. Everything is ONE
   * statement: each table is scanned once with `count(*) FILTER (...)`
   * instead of one query per number, which was 13 statements holding up to
   * 13 pool connections at once for a single page tile.
   *
   * Cached in Redis for 60s under `rk:stats:app:<id>` (lib/dashboard-cache.ts).
   * The counts may lag by that much; `billing.enabled` is the one value an
   * operator edits directly, so `updateBillingConfig` drops the key.
   */
  async stats(applicationId: string): Promise<ApplicationStats> {
    return cachedDashboard(statsCacheKey(applicationId), 60, () => computeStats(applicationId));
  },
};

export function statsCacheKey(applicationId: string): string {
  return `rk:stats:app:${applicationId}`;
}

async function computeStats(applicationId: string): Promise<ApplicationStats> {
  const now = Date.now();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);
  // Trend window: 30 calendar days inclusive of today.
  const TREND_DAYS = 30;
  const trendStart = new Date(now - (TREND_DAYS - 1) * 24 * 60 * 60 * 1000);
  trendStart.setUTCHours(0, 0, 0, 0);

  const [row] = await prisma.$queryRaw<
    Array<{
      billing_config: unknown;
      users_total: bigint;
      users_verified: bigint;
      users_new_7d: bigint;
      users_new_30d: bigint;
      events_30d: bigint;
      sign_ins_30d: bigint;
      sign_ups_30d: bigint;
      active_subscriptions: bigint;
      plans_active: bigint;
      plans_total: bigint;
      credits_outstanding: bigint | null;
      usage_30d: bigint | null;
      trend: Array<{ day: string; count: number }> | null;
    }>
  >(Prisma.sql`
    SELECT
      (SELECT "billing_config" FROM "applications" WHERE "id" = ${applicationId}) AS billing_config,
      eu.total AS users_total, eu.verified AS users_verified,
      eu.new_7d AS users_new_7d, eu.new_30d AS users_new_30d,
      se.events AS events_30d, se.sign_ins AS sign_ins_30d, se.sign_ups AS sign_ups_30d,
      (SELECT count(*) FROM "subscriptions"
        WHERE "application_id" = ${applicationId} AND "status" = 'ACTIVE') AS active_subscriptions,
      pl.active AS plans_active, pl.total AS plans_total,
      (SELECT sum("balance") FROM "credit_balances"
        WHERE "application_id" = ${applicationId}) AS credits_outstanding,
      (SELECT sum(ur."quantity") FROM "usage_records" ur
        JOIN "usage_meters" um ON um."id" = ur."meter_id"
        WHERE um."application_id" = ${applicationId} AND ur."occurred_at" >= ${since30d}) AS usage_30d,
      (SELECT json_agg(json_build_object('day', t.day, 'count', t.count) ORDER BY t.day)
        FROM (
          SELECT to_char(date_trunc('day', "created_at"), 'YYYY-MM-DD') AS day,
                 count(*)::int AS count
          FROM "end_users"
          WHERE "application_id" = ${applicationId} AND "created_at" >= ${trendStart}
          GROUP BY 1
        ) t) AS trend
    FROM
      (SELECT count(*) AS total,
              count(*) FILTER (WHERE "email_verified") AS verified,
              count(*) FILTER (WHERE "created_at" >= ${since7d}) AS new_7d,
              count(*) FILTER (WHERE "created_at" >= ${since30d}) AS new_30d
         FROM "end_users" WHERE "application_id" = ${applicationId}) eu,
      (SELECT count(*) AS events,
              count(*) FILTER (WHERE "type" = 'user.signed_in') AS sign_ins,
              count(*) FILTER (WHERE "type" = 'user.signed_up') AS sign_ups
         FROM "security_events"
        WHERE "application_id" = ${applicationId} AND "created_at" >= ${since30d}) se,
      (SELECT count(*) FILTER (WHERE "active") AS active, count(*) AS total
         FROM "plans" WHERE "application_id" = ${applicationId}) pl
  `);
  if (!row) throw new Error('stats query returned no row');
  const billingConfig = BillingConfigSchema.parse(row.billing_config ?? {});

  // Densify the trend to one entry per day so the panel renders a gap-free
  // sparkline (days with no sign-ups become explicit zeroes).
  const byDay = new Map<string, number>();
  for (const r of row.trend ?? []) byDay.set(r.day, Number(r.count));
  const signupTrend: Array<{ date: string; count: number }> = [];
  for (let i = 0; i < TREND_DAYS; i++) {
    const d = new Date(trendStart.getTime() + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    signupTrend.push({ date: key, count: byDay.get(key) ?? 0 });
  }

  return {
    users: {
      total: Number(row.users_total),
      verified: Number(row.users_verified),
      newLast7d: Number(row.users_new_7d),
      newLast30d: Number(row.users_new_30d),
      signupTrend,
    },
    security: {
      eventsLast30d: Number(row.events_30d),
      signInsLast30d: Number(row.sign_ins_30d),
      signUpsLast30d: Number(row.sign_ups_30d),
    },
    billing: {
      enabled: billingConfig.enabled,
      activeSubscriptions: Number(row.active_subscriptions),
      plansActive: Number(row.plans_active),
      plansTotal: Number(row.plans_total),
    },
    usage: {
      creditsOutstanding: Number(row.credits_outstanding ?? 0),
      usageLast30d: Number(row.usage_30d ?? 0),
    },
  };
}

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
