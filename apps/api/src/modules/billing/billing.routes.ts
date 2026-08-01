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

const SubscriptionQuery = z.object({ organizationId: z.string().min(1).optional() });

const PaymentsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

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
      },
    },
    async (req) => ({
      success: true,
      data: await billingService.listActivePlans(req.application!),
    }),
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
          'org-billed app. Requires the user JWT in X-Rekey-User-Token.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        querystring: { type: 'object', properties: { organizationId: { type: 'string' } } },
      },
    },
    async (req) => {
      const { organizationId } = SubscriptionQuery.parse(req.query);
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
          organizationId ? { organizationId } : undefined,
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
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
        },
      },
    },
    async (req) => {
      const { limit } = PaymentsQuery.parse(req.query);
      return {
        success: true,
        data: await billingService.listPaymentsForEndUser(
          req.application!,
          req.endUser!.id,
          limit !== undefined ? { limit } : undefined,
        ),
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
