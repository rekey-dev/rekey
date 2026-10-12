/**
 * The place a coupon code is entered: `POST /api/v1/billing/coupons/validate`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BillingConfigSchema, formatMoney } from '@rekey.dev/shared-types';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { requireBillingEnabled } from '../../middleware/billing-enabled.js';
import { ok, errs, ref } from '../../lib/openapi.js';
import { COUNTRY_INPUT, resolveBuyerCountry } from '../billing/buyer-country.js';
import { resolveCheckoutDiscount } from '../billing/checkout-discount.js';
import { loadCheckoutPreviewRows, previewCheckoutPrice, previewCheckoutProvider } from '../billing/checkout-preview.js';
import { assertCheckoutSubject } from '../billing/checkout-subject.js';
import type { BillingProviderName } from '../billing/credentials.service.js';
import { isOneTimePlan } from '../billing/plan-kind.js';
import { providerNameSchema } from '../billing/providers/registry.js';
import { organizationsService } from '../organizations/organizations.service.js';
import { toPriceFallbackDto, toResolvedPriceDto } from '../plans/plan-dto.js';
import { plansService } from '../plans/plans.service.js';
import { serializePublicCoupon } from './coupon-dto.js';
import { couponsService } from './coupons.service.js';

const ValidateBody = z.object({
  code: z.string().min(1).max(40),
  planSlug: z.string().min(1).max(40),
  country: z.string().regex(COUNTRY_INPUT).optional(),
  currency: z.string().length(3).optional(),
  onUnavailableCurrency: z.enum(['fallback', 'refuse']).optional(),
  provider: providerNameSchema.optional(),
  organizationId: z.string().min(1).optional(),
});

/**
 * Where a buyer enters a code, before the checkout is opened. It accepts the
 * publishable key exactly like `POST /billing/checkout`, which takes the same
 * `couponCode`, and answers with the refusal that checkout would give.
 *
 * The user JWT is the authorizer: per-user redemption limits are evaluated
 * against `req.endUser`.
 *
 * `billing:read` binds SECRET-key callers only. `requireScope` no-ops for a
 * publishable request since a publishable key carries no scopes to check; the
 * origin allowlist and the user session constrain it instead.
 */
export async function couponsPublicRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireBillingEnabled);
  app.addHook('onRequest', requireScope('billing:read'));
  app.addHook('onRequest', requireUserSession);

  app.post(
    '/validate',
    {
      schema: {
        tags: ['Public · Billing'],
        summary: 'Validate a coupon for the current user against a plan',
        description:
          "Returns the discount on success, and on every refusal a RekeyError a pricing page can show.\n\n" +
          "The quote is made against the price this caller's checkout would charge: the currency " +
          'the buyer already pays in, then `currency` from a secret key, then the price that applies ' +
          "in the buyer's country, then the default, and the default again when the price selected " +
          'cannot be charged (`priceFallback` then says so). Send the same `country`, `currency`, ' +
          '`onUnavailableCurrency`, `provider` and `organizationId` the checkout will send: each of ' +
          "them can change the price.\n\n" +
          'A coupon is judged in the currency charged. A fixed-amount coupon with no amount in that ' +
          'currency, or a percentage coupon limited to other currencies, answers ' +
          'COUPON_CURRENCY_NOT_COVERED here and at checkout: nothing is converted and the discount is ' +
          "never dropped silently. The buyer may continue without the code. A discount the checkout's " +
          "provider cannot apply is refused here too.\n\n" +
          'Callable from a browser with the publishable key, or from your server ' +
          'with a secret key carrying the `billing:read` scope. Either way the ' +
          'end-user JWT is required, because per-user redemption limits are ' +
          'checked against that user.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: {
          type: 'object',
          required: ['code', 'planSlug'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 40, description: 'The coupon code the buyer entered. Any case.' },
            planSlug: { type: 'string', minLength: 1, maxLength: 40, description: 'The slug of the plan the buyer is about to buy.' },
            country: {
              type: 'string',
              pattern: COUNTRY_INPUT.source,
              description:
                "The buyer's country, ISO 3166-1 alpha-2. From a secret key it is taken as fact. " +
                'From a publishable key it is a hint, used only when no trusted proxy vouched for ' +
                'one, and it selects a local price only when the Application sets ' +
                '`billingConfig.localPrices` to `any`.',
            },
            currency: {
              type: 'string',
              minLength: 3,
              maxLength: 3,
              description:
                "Secret key only. Quote the plan's price in this ISO 4217 currency, as " +
                '`POST /billing/checkout` would charge it. The plan must have a price in it.',
            },
            onUnavailableCurrency: {
              type: 'string',
              enum: ['fallback', 'refuse'],
              description:
                'Secret key only, as at checkout. `refuse` answers BILLING_NO_PROVIDER_FOR_CURRENCY ' +
                "where `fallback` quotes the plan's default price. Left out, the Application's " +
                '`billingConfig.onUnavailableCurrency` decides, as at checkout.',
            },
            provider: {
              type: 'string',
              description:
                'The provider the checkout will name, if it names one. The quote is then made ' +
                'at the price that provider can charge, and a provider the checkout would ' +
                'refuse is refused here with the same code.',
            },
            organizationId: {
              type: 'string',
              minLength: 1,
              description:
                'The organization the checkout will bill, for an Application that bills per ' +
                'organization. The caller must be an OWNER or ADMIN of it, as at checkout.',
            },
          },
        },
        response: {
          200: ok(
            ref('ValidateCouponResult'),
            'The discount this coupon resolves to for this plan.',
          ),
          ...errs({
            400:
              'VALIDATION_ERROR: the body failed schema validation; or ' +
              'BILLING_ORGANIZATION_REQUIRED: the Application bills per organization and no ' +
              '`organizationId` was sent; or BILLING_ORGANIZATION_NOT_ACCEPTED: it bills per ' +
              'user and one was; or BILLING_PROVIDER_NOT_AVAILABLE / ' +
              'BILLING_PROVIDER_CURRENCY_UNSUPPORTED: the checkout would refuse `provider`; or COUPON_INACTIVE / ' +
              'COUPON_NOT_YET_STARTED / COUPON_EXPIRED / COUPON_NOT_APPLICABLE / ' +
              'COUPON_REDEMPTION_LIMIT_REACHED / COUPON_USER_LIMIT_REACHED: the coupon cannot be used ' +
              'by this user on this plan; or COUPON_CURRENCY_NOT_COVERED: the coupon does not work in ' +
              'the currency the checkout would charge (`details.chargedCurrency`); or COUPON_NO_DISCOUNT: ' +
              'it takes nothing off this price; or COUPON_FULL_DISCOUNT_UNSUPPORTED: it covers the whole ' +
              'price of a one-time purchase; or BILLING_DISCOUNT_UNSUPPORTED: the provider the checkout ' +
              'would use cannot apply a discount on this kind of purchase; or ' +
              'BILLING_CURRENCY_NOT_ALLOWED: `currency` was sent with a publishable key; or ' +
              'BILLING_PLAN_CURRENCY_UNAVAILABLE: the plan has no price in `currency`; or ' +
              'BILLING_NO_PROVIDER_FOR_CURRENCY: no provider the checkout could use charges `currency`.',
            401:
              'API_KEY_MISSING / API_KEY_INVALID: the secret key is missing, malformed, or ' +
              'unknown/revoked/expired; or PUBLISHABLE_KEY_INVALID: the publishable key is ' +
              'unknown or has rotated out; or USER_TOKEN_MISSING: no X-Rekey-User-Token ' +
              'header; or USER_TOKEN_INVALID: the token is invalid/expired/wrong-secret; or ' +
              'USER_TOKEN_WRONG_APPLICATION: the token was issued for a different Application; ' +
              'or IMPERSONATION_SESSION_ENDED: the impersonation session behind this token has ended.',
            403:
              "IP_NOT_ALLOWED: caller IP outside the secret key's allowlist; or " +
              "ORIGIN_NOT_ALLOWED: the Origin is outside the publishable key's CORS allowlist; " +
              'or BILLING_DISABLED: billing is not enabled for this application; or ' +
              'ORGANIZATION_ROLE_INSUFFICIENT / ORGANIZATION_NOT_MEMBER: the caller may not buy for `organizationId`.',
            404: 'PLAN_NOT_FOUND: no plan with that slug; or COUPON_NOT_FOUND: no active coupon matching the code.',
            409: 'BILLING_CURRENCY_CONFLICT: the buyer already pays in another currency than the `currency` asked for.',
            429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const body = ValidateBody.parse(req.body);
      const plan = await plansService.getBySlug(
        req.application!.id,
        body.planSlug,
      );
      if (body.organizationId !== undefined) {
        await organizationsService.requireRole(
          {
            application: req.application!,
            actorEndUserId: req.endUser!.id,
            organizationId: body.organizationId,
          },
          ['OWNER', 'ADMIN'],
        );
      }
      assertCheckoutSubject(
        BillingConfigSchema.parse(req.application!.billingConfig)
          .billingSubject,
        body.organizationId,
      );
      const who = {
        application: req.application!,
        endUserId: req.endUser!.id,
        beneficiaryOrgId: body.organizationId,
        buyer: resolveBuyerCountry(req, body.country),
        callerIsSecretKey: req.authKind === 'secret',
      };
      const preview = {
        ...who,
        plan,
        requestedCurrency: body.currency,
        onUnavailableCurrency: body.onUnavailableCurrency,
        provider: body.provider as BillingProviderName | undefined,
        rows: await loadCheckoutPreviewRows(who, [plan]),
      };
      const { priced, price } = await previewCheckoutPrice(preview);
      const result = await couponsService.validate({
        applicationId: req.application!.id,
        endUserId: req.endUser!.id,
        code: body.code,
        planSlug: plan.slug,
        amount: priced.amount,
        currency: priced.currency,
        fallbackFrom: price?.fallback?.requested.currency,
      });
      // The checkout's own two steps after it validates a coupon, in its
      // order: pick the provider, then ask whether that provider can apply
      // this discount to this kind of purchase.
      resolveCheckoutDiscount({
        plan: priced,
        provider: await previewCheckoutProvider(preview),
        isOneTime: isOneTimePlan(plan),
        coupon: { couponId: result.coupon.id, code: result.coupon.code, discountAmount: result.discountAmount },
        endUserId: req.endUser!.id,
      });
      const currency = priced.currency.toUpperCase();
      return {
        success: true,
        data: {
          coupon: serializePublicCoupon(result.coupon),
          plan: { slug: plan.slug, name: plan.name },
          price: toResolvedPriceDto(price),
          priceFallback: toPriceFallbackDto(price),
          currency,
          amount: priced.amount,
          discountAmount: result.discountAmount,
          amountAfterDiscount: result.amountAfterDiscount,
          formatted: {
            discount: formatMoney(result.discountAmount, currency),
            total: formatMoney(result.amountAfterDiscount, currency),
          },
        },
      };
    },
  );
}
