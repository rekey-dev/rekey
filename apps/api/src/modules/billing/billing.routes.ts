import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { billingService } from './billing.service.js';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { requireBillingEnabled } from '../../middleware/billing-enabled.js';
import { billingCredentialsService, type BillingProviderName } from './credentials.service.js';
import { countryFromRequest } from './providers/index.js';
import { getModule, providerNameSchema } from './providers/registry.js';
import { entitlementsService } from './entitlements.service.js';
import { organizationsService } from '../organizations/organizations.service.js';
import { ok, okPage, errs, ref, type JsonSchema } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';

/**
 * The auth/gate failure modes shared by every route behind
 * `requirePublishableOrSecretKey` + `requireBillingEnabled` +
 * `requireScope('billing:read')`. Order matches the onRequest chain: key
 * resolution, then the billing gate, then the scope check.
 */
const READ_GATE_ERRORS = {
  401:
    'API_KEY_MISSING / API_KEY_INVALID — the Authorization header is missing, or the secret key ' +
    'is malformed, unknown, revoked, or expired; or PUBLISHABLE_KEY_INVALID — the publishable ' +
    'key is unknown or its rotation grace window has ended.',
  403:
    "IP_NOT_ALLOWED — caller IP outside the secret key's allowlist; or ORIGIN_NOT_ALLOWED — the " +
    "request Origin is outside the publishable key's CORS allowlist; or BILLING_DISABLED — " +
    'billing is not enabled for this application; or API_KEY_SCOPE_INSUFFICIENT — the secret ' +
    'key lacks the `billing:read` scope (a publishable request is pre-authorized for this route).',
  429: 'RATE_LIMITED — too many requests. Honour the Retry-After header.',
} as const;

/** Same chain, `billing:write` instead. */
const WRITE_GATE_ERRORS = {
  401: READ_GATE_ERRORS[401],
  403: READ_GATE_ERRORS[403].replace('billing:read', 'billing:write'),
  429: READ_GATE_ERRORS[429],
} as const;

/** READ_GATE_ERRORS plus the failure modes of `requireUserSession`, which runs last. */
const USER_READ_GATE_ERRORS = {
  401:
    READ_GATE_ERRORS[401] +
    ' USER_TOKEN_MISSING — no X-Rekey-User-Token header; USER_TOKEN_INVALID — the user token ' +
    'is invalid, expired, or signed with a different secret; USER_TOKEN_WRONG_APPLICATION — ' +
    'the token was issued for a different Application; IMPERSONATION_SESSION_ENDED — the ' +
    'impersonation session behind this token has ended.',
  403: READ_GATE_ERRORS[403],
  429: READ_GATE_ERRORS[429],
} as const;

/** WRITE_GATE_ERRORS plus the same `requireUserSession` failure modes. */
const USER_WRITE_GATE_ERRORS = {
  401: USER_READ_GATE_ERRORS[401],
  403: WRITE_GATE_ERRORS[403],
  429: READ_GATE_ERRORS[429],
} as const;

/**
 * `GET /entitlements` and `GET /subscription` return
 * `{success, data: <...>}` for `entitlementsService.resolveForEndUser` and
 * the nullable current Subscription respectively — neither has a registered
 * component, so they're modelled inline here.
 */
const ResolvedEntitlements: JsonSchema = {
  type: 'object',
  description:
    "The union of the caller's benefits: feature flags, the live credit balance, and the raw " +
    'resolved entitlement list.',
  properties: {
    features: {
      type: 'object',
      description: 'Feature flag key → typed value (boolean, number, or string).',
      additionalProperties: { oneOf: [{ type: 'boolean' }, { type: 'number' }, { type: 'string' }] },
    },
    entitlements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'e.g. FEATURE, CREDIT, LICENSE, USAGE.' },
          key: { type: 'string' },
          valueType: { type: 'string', nullable: true },
          value: { type: 'string', nullable: true },
          quantity: { type: 'integer', nullable: true },
          licenseKind: { type: 'string', nullable: true },
          rollover: { type: 'boolean' },
        },
        required: ['kind', 'key', 'rollover'],
      },
    },
    creditBalance: { type: 'integer' },
  },
  required: ['features', 'entitlements', 'creditBalance'],
};

/** `data` for `GET /subscription` — the current Subscription, or `null`. */
const NullableSubscription: JsonSchema = { nullable: true, allOf: [ref('Subscription')] };

const CheckoutBody = z.object({
  planSlug: z.string().min(1).max(40),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  couponCode: z.string().min(1).max(40).optional(),
  // Registry-derived (P4): adding a provider module extends checkout's
  // accepted values without touching this file.
  provider: providerNameSchema.optional(),
  country: z.string().length(2).optional(),
  /** Buy for an org (owner+beneficiary). Caller must be OWNER/ADMIN of it. */
  organizationId: z.string().min(1).optional(),
});

const EntitlementsQuery = z.object({ organizationId: z.string().min(1).optional() });

const SubscriptionQuery = z.object({
  organizationId: z.string().min(1).optional(),
  /**
   * Deliberately not `z.coerce.boolean()` (which the two `includeInactive`
   * query params use): coercion is JS truthiness, so a raw `?includeEnded=false`
   * that reached zod without ajv having narrowed it would parse as TRUE. A flag
   * whose "off" spelling switches it on is worse than no flag. Booleans arrive
   * here already coerced by the querystring schema below; the string arm is the
   * belt to that braces.
   */
  includeEnded: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

const PaymentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

const CancelBody = z
  .object({ atPeriodEnd: z.boolean().optional(), organizationId: z.string().min(1).optional() })
  .default({});

/** Public billing surface — Application API key auth, optionally + user session. */
export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // GET /plans is application-scope only (no user session needed —
  // pricing pages are public). Subscription + checkout require a user.
  app.get(
    '/plans',
    {
      // Public catalogue — a pricing page in a browser-only app must reach this
      // with no backend, so it accepts the publishable key (or a secret key).
      onRequest: [requirePublishableOrSecretKey, requireBillingEnabled, requireScope('billing:read')],
      schema: {
        tags: ['Public · Billing'],
        summary: 'List active plans for the calling application',
        description:
          'Returns the public plan catalogue. End-users typically reach this via your pricing page.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('Plan'), 'A page of active plans for the calling application.'),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...READ_GATE_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [items, total] = await Promise.all([
        billingService.listActivePlans(req.application!, { take, skip }),
        billingService.countActivePlans(req.application!),
      ]);
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.get(
    '/entitlements',
    {
      onRequest: [requirePublishableOrSecretKey, requireBillingEnabled, requireScope('billing:read'), requireUserSession],
      schema: {
        tags: ['Public · Billing'],
        summary: "Resolve the calling end-user's current entitlements",
        description:
          'Union of the benefits granted by the user\'s ACTIVE subscriptions: feature flags ' +
          '(key → typed value), the live credit balance, and the raw resolved entitlement list. ' +
          'Default = the user view (own subs + subs of orgs they belong to). Pass ' +
          '`?organizationId=` (member-only) for that org\'s view + shared pool. Requires the user JWT.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        querystring: { type: 'object', properties: { organizationId: { type: 'string' } } },
        response: {
          200: ok(ResolvedEntitlements, "The caller's resolved entitlements."),
          ...errs({
            ...USER_READ_GATE_ERRORS,
            403:
              USER_READ_GATE_ERRORS[403] +
              ' ORGANIZATION_NOT_MEMBER — `organizationId` was passed but the caller is not a ' +
              'member of that organization.',
          }),
        },
      },
    },
    async (req) => {
      const { organizationId: explicit } = EntitlementsQuery.parse(req.query);
      let orgView: string | undefined;
      if (explicit) {
        // Explicit ask → strict: confirm the caller belongs to the org (403 if not).
        await organizationsService.requireMembership({
          application: req.application!,
          actorEndUserId: req.endUser!.id,
          organizationId: explicit,
        });
        orgView = explicit;
      } else if (req.activeOrganizationId) {
        // No explicit org → default to the session's active org (`oid` claim),
        // but only if still a member. A stale claim silently falls back to the
        // personal view rather than 403-ing the whole call.
        const member = await organizationsService.isMember({
          applicationId: req.application!.id,
          endUserId: req.endUser!.id,
          organizationId: req.activeOrganizationId,
        });
        if (member) orgView = req.activeOrganizationId;
      }
      return {
        success: true,
        data: await entitlementsService.resolveForEndUser(
          req.application!.id,
          req.endUser!.id,
          orgView ? { organizationId: orgView } : undefined,
        ),
      };
    },
  );

  app.get(
    '/subscription',
    {
      onRequest: [requirePublishableOrSecretKey, requireBillingEnabled, requireScope('billing:read'), requireUserSession],
      schema: {
        tags: ['Public · Billing'],
        summary: 'Get the current active subscription (the user\'s own, or an org\'s), or null',
        description:
          'Returns null when there is no active/pending/past-due subscription. Pass ' +
          '`?organizationId=` (member-only) to read an organization\'s subscription on an ' +
          'org-billed app. Pass `?includeEnded=true` to fall back to the most recent CANCELED ' +
          'or EXPIRED subscription when there is no live one — for a portal that has to say ' +
          'what a customer used to be on and when it ended, instead of showing a former ' +
          'subscriber the same empty state as someone who never subscribed. The flag can only ' +
          'turn a null into a row: when a live subscription exists it is still the one ' +
          'returned. Requires the user JWT in X-Rekey-User-Token.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        querystring: {
          type: 'object',
          properties: {
            organizationId: { type: 'string' },
            includeEnded: {
              type: 'boolean',
              description:
                'Fall back to the most recent CANCELED/EXPIRED subscription when there is no ' +
                'active, pending or past-due one. Never replaces a live subscription. Default false.',
            },
          },
        },
        response: {
          200: ok(NullableSubscription, 'The current subscription, or null when none exists.'),
          ...errs({
            400: 'VALIDATION_ERROR — `includeEnded` is not a boolean.',
            ...USER_READ_GATE_ERRORS,
            403:
              USER_READ_GATE_ERRORS[403] +
              ' ORGANIZATION_NOT_MEMBER — `organizationId` was passed but the caller is not a ' +
              'member of that organization.',
          }),
        },
      },
    },
    async (req) => {
      const { organizationId, includeEnded } = SubscriptionQuery.parse(req.query);
      if (organizationId) {
        // Reading an org's subscription — caller must be a member (403 if not).
        await organizationsService.requireMembership({
          application: req.application!,
          actorEndUserId: req.endUser!.id,
          organizationId,
        });
      }
      return {
        success: true,
        // PublicEndUser lacks passwordHash; the service signature wants EndUser.
        // Cast is safe — billing only reads id/applicationId.
        data: await billingService.getCurrentSubscription(
          req.application!,
          { ...req.endUser!, passwordHash: null } as never,
          { ...(organizationId && { organizationId }), includeEnded },
        ),
      };
    },
  );

  app.get(
    '/payments',
    {
      onRequest: [requirePublishableOrSecretKey, requireBillingEnabled, requireScope('billing:read'), requireUserSession],
      schema: {
        tags: ['Public · Billing'],
        summary: "List the calling end-user's own payments",
        description:
          'Payment history for the authenticated end-user only — newest first, default 50 ' +
          '(max 100 via ?limit=). Each row carries a `receiptUrl` when the provider receipt ' +
          'link is known, else null. Requires the user JWT in X-Rekey-User-Token.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0, maximum: 2147483647 },
          },
        },
        response: {
          // A distinct projection from `Payment` (TenantPaymentDto): it drops
          // endUserId/providerPaymentId/endUserEmail (already known to the
          // caller / internal) and adds planSlug + receiptUrl, so it is
          // modelled inline rather than via `ref('Payment')`.
          200: okPage(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                amount: { type: 'integer', description: 'Smallest currency unit.' },
                currency: { type: 'string' },
                status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] },
                description: { type: 'string', nullable: true },
                createdAt: { type: 'string', format: 'date-time' },
                subscriptionId: { type: 'string', nullable: true },
                planSlug: { type: 'string', nullable: true },
                receiptUrl: { type: 'string', format: 'uri', nullable: true },
              },
              required: ['id', 'amount', 'currency', 'status', 'createdAt'],
            },
            "A page of the calling end-user's own payments, newest first.",
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...USER_READ_GATE_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const q = PaymentsQuery.parse(req.query);
      const page = await billingService.listPaymentsForEndUser(req.application!, req.endUser!.id, {
        ...(q.limit !== undefined && { limit: q.limit }),
        ...(q.offset !== undefined && { offset: q.offset }),
      });
      return {
        success: true,
        // `limit`/`offset` come back from the service because it applies its
        // own clamps (1..100, >=0) — reporting the values the caller SENT
        // would describe a window the server did not serve.
        data: paged(page.items, page.total, page.limit, page.offset),
      };
    },
  );

  app.post(
    '/subscription/cancel',
    {
      onRequest: [requirePublishableOrSecretKey, requireBillingEnabled, requireScope('billing:write'), requireUserSession],
      // Generic Idempotency-Key header support (scoped to the Application).
      config: { idempotency: true },
      schema: {
        tags: ['Public · Billing'],
        summary: "Cancel the calling end-user's current subscription",
        description:
          'Default = cancel at period end (provider-backed ACTIVE subscriptions stay ACTIVE ' +
          'with `cancelAt` set until the provider webhook terminates them). Pass ' +
          '`{"atPeriodEnd": false}` to cancel immediately. PENDING checkouts and ' +
          'subscriptions with no provider-side record are canceled locally right away. ' +
          'Requires the user JWT in X-Rekey-User-Token.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        body: {
          type: 'object',
          properties: {
            atPeriodEnd: {
              type: 'boolean',
              description: 'true (default) = stop at period end; false = stop immediately.',
            },
          },
        },
        response: {
          200: ok(ref('Subscription'), 'The (now canceling or canceled) subscription.'),
          ...errs({
            400:
              'VALIDATION_ERROR — the body failed schema validation; or IDEMPOTENCY_KEY_INVALID ' +
              '— the Idempotency-Key header is empty or exceeds 200 characters.',
            ...USER_WRITE_GATE_ERRORS,
            403:
              USER_WRITE_GATE_ERRORS[403] +
              ' ORGANIZATION_NOT_MEMBER — `organizationId` was passed but the caller is not a ' +
              'member of it; or ORGANIZATION_ROLE_INSUFFICIENT — canceling an organization\'s ' +
              'subscription requires OWNER or ADMIN.',
            404: 'SUBSCRIPTION_NOT_FOUND — the caller has no active/pending/past-due subscription to cancel.',
            409:
              'IDEMPOTENCY_KEY_IN_FLIGHT — a request with this Idempotency-Key is still being ' +
              'processed; or IDEMPOTENCY_KEY_REUSED — the key was already used for a different ' +
              'method, path, or body.',
          }),
        },
      },
    },
    async (req) => {
      const body = CancelBody.parse(req.body ?? {});
      if (body.organizationId) {
        // Canceling an org's subscription is an OWNER/ADMIN action.
        await organizationsService.requireRole(
          {
            application: req.application!,
            actorEndUserId: req.endUser!.id,
            organizationId: body.organizationId,
          },
          ['OWNER', 'ADMIN'],
        );
      }
      const subscription = await billingService.cancelCurrentSubscription(
        req.application!,
        { ...req.endUser!, passwordHash: null } as never,
        {
          ...(body.atPeriodEnd !== undefined && { atPeriodEnd: body.atPeriodEnd }),
          ...(body.organizationId && { organizationId: body.organizationId }),
        },
      );
      return { success: true, data: subscription };
    },
  );

  app.post(
    '/checkout',
    {
      onRequest: [requirePublishableOrSecretKey, requireBillingEnabled, requireScope('billing:write'), requireUserSession],
      // Generic Idempotency-Key header support (scoped to the Application).
      config: { idempotency: true },
      schema: {
        tags: ['Public · Billing'],
        summary: 'Start a checkout session for the current end-user',
        description:
          'Creates (or reuses) a PENDING Subscription locally and returns a provider-hosted ' +
          'checkout URL. Activation happens via the provider\'s webhook — not synchronously here.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        body: {
          type: 'object',
          required: ['planSlug', 'successUrl', 'cancelUrl'],
          properties: {
            planSlug: { type: 'string', minLength: 1, maxLength: 40 },
            successUrl: { type: 'string', format: 'uri' },
            cancelUrl: { type: 'string', format: 'uri' },
            couponCode: {
              type: 'string',
              minLength: 1,
              maxLength: 40,
              description: 'Optional coupon to apply. Validated server-side; a bad code rejects the whole checkout.',
            },
            organizationId: {
              type: 'string',
              description: 'Buy for an organization (owner+beneficiary). Caller must be OWNER/ADMIN of it.',
            },
          },
        },
        response: {
          200: ok(ref('CheckoutResult'), 'The provider checkout session.'),
          ...errs({
            400:
              'VALIDATION_ERROR — the body failed schema validation; or IDEMPOTENCY_KEY_INVALID ' +
              '— the Idempotency-Key header is empty or exceeds 200 characters; or ' +
              'BILLING_ORGANIZATION_REQUIRED — this Application bills per organization and no ' +
              '`organizationId` was given; or PLAN_INACTIVE — the plan is not open for new ' +
              'sign-ups; or COUPON_INACTIVE / COUPON_NOT_YET_STARTED / COUPON_EXPIRED / ' +
              'COUPON_NOT_APPLICABLE / COUPON_CURRENCY_MISMATCH / COUPON_REDEMPTION_LIMIT_REACHED ' +
              '/ COUPON_USER_LIMIT_REACHED / COUPON_NO_DISCOUNT / COUPON_FULL_DISCOUNT_UNSUPPORTED ' +
              '— the coupon failed validation for this plan/user; or BILLING_CREDENTIALS_NOT_CONFIGURED ' +
              '— no provider is configured for this Application; or BILLING_PROVIDER_NOT_AVAILABLE ' +
              '— the requested `provider` is not configured/enabled.',
            ...USER_WRITE_GATE_ERRORS,
            403:
              USER_WRITE_GATE_ERRORS[403] +
              ' ORGANIZATION_NOT_MEMBER — `organizationId` was passed but the caller is not a ' +
              'member of it; or ORGANIZATION_ROLE_INSUFFICIENT — buying for an organization ' +
              'requires OWNER or ADMIN.',
            404: 'PLAN_NOT_FOUND — no plan with that slug in this application; or COUPON_NOT_FOUND — no active coupon matching the code.',
            409:
              'IDEMPOTENCY_KEY_IN_FLIGHT — a request with this Idempotency-Key is still being ' +
              'processed; or IDEMPOTENCY_KEY_REUSED — the key was already used for a different ' +
              'method, path, or body; or BILLING_PROVIDER_SWITCH_BLOCKED — an active subscription ' +
              'on this plan already exists via a different provider; or COUPON_CHECKOUT_ALREADY_OPEN ' +
              '— the caller already has an open checkout holding this coupon.',
          }),
        },
      },
    },
    async (req) => {
      const body = CheckoutBody.parse(req.body);
      const country = body.country ?? countryFromRequest(req.headers);
      if (body.organizationId) {
        // Only an OWNER/ADMIN of the org may spend on its behalf.
        await organizationsService.requireRole(
          { application: req.application!, actorEndUserId: req.endUser!.id, organizationId: body.organizationId },
          ['OWNER', 'ADMIN'],
        );
      }
      const result = await billingService.createCheckoutSession({
        application: req.application!,
        endUser: { ...req.endUser!, passwordHash: null } as never,
        planSlug: body.planSlug,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        ...(body.couponCode !== undefined && { couponCode: body.couponCode }),
        // providerNameSchema guarantees a REGISTERED name; the credentials
        // service's literal union is exactly the registered set today.
        ...(body.provider !== undefined && { provider: body.provider as BillingProviderName }),
        ...(country !== undefined && { country }),
        ...(body.organizationId !== undefined && { beneficiaryOrgId: body.organizationId }),
      });
      return {
        success: true,
        data: {
          url: result.url,
          subscription: result.subscription,
          discountAmount: result.discountAmount,
          provider: result.provider,
        },
      };
    },
  );

  // Public — list providers configured + enabled for the calling Application.
  // Front-ends use this to render a "Pay with..." picker. No user session
  // needed; this is the same trust level as /plans, so it accepts the
  // PUBLISHABLE key too (a browser-only / hosted-portal checkout can fetch the
  // picker list directly).
  app.get(
    '/providers',
    {
      onRequest: [requirePublishableOrSecretKey, requireBillingEnabled, requireScope('billing:read')],
      schema: {
        tags: ['Public · Billing'],
        summary: 'List enabled billing providers for the calling application',
        description:
          'Returns providers configured + enabled for this Application, in the order ' +
          'the geo router would prefer them given the request country (CF-IPCountry header).',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        response: {
          // Not okArray/okPage: the payload is `{country, providers}`, not a
          // bare list, and `providers` is bounded by construction (the fixed
          // provider registry — at most a handful of entries), not tenant data.
          200: ok(
            {
              type: 'object',
              properties: {
                country: { type: 'string', nullable: true, description: 'ISO 3166-1 alpha-2, or null when unresolvable.' },
                providers: { type: 'array', items: ref('BillingProviderInfo') },
              },
              required: ['country', 'providers'],
            },
            'Providers configured + enabled for this application, geo-ordered.',
          ),
          ...errs(READ_GATE_ERRORS),
        },
      },
    },
    async (req) => {
      const country = countryFromRequest(req.headers);
      const visible = await billingCredentialsService.listEnabled(req.application!.id, country);
      return {
        success: true,
        data: {
          country: country ?? null,
          // P4 discovery additions (label/docsUrl/capabilities) are ADDITIVE —
          // the original three fields and the geo-router ordering are pinned
          // by SDK + portal consumers and must not change.
          providers: visible.map((p) => {
            const m = getModule(p.provider);
            return {
              provider: p.provider,
              priority: p.priority,
              countries: p.countries,
              ...(m !== undefined && {
                label: m.display.label,
                docsUrl: m.display.docsUrl,
                capabilities: m.capabilities,
              }),
            };
          }),
        },
      };
    },
  );
}
