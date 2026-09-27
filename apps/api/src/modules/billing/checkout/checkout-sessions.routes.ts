/**
 * Public routes behind the Rekey-hosted checkout page.
 *
 * The token in the path is the credential: 32 random bytes, stored only as a
 * hash, unusable once the session is complete or expired. No publishable key
 * is asked for because the page cannot know it before reading the session.
 * The portal calls these server-side; nothing here sets or reads a cookie.
 *
 * Rate limits: a bucket per token, so polling cannot be turned into load, and
 * a per-IP ceiling across tokens, so guessing tokens costs a fresh bucket
 * nothing.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { RekeyError } from '../../../lib/error.js';
import { errs, ok, ref } from '../../../lib/openapi.js';
import { portalBaseOrigin } from '../../../lib/portal-origins.js';
import { globalRateLimitMax, rateLimitedAfter, skipUnvouchedIp } from '../../../lib/rate-limit.js';
import { confirmProbeNonce } from './portal-probe.js';
import { checkoutFallbackUrl, checkoutPageView, checkoutStatus } from './sessions.service.js';
import { confirmPaypalApproval } from './paypal-approval.js';

const ApprovedBody = z.object({ subscriptionId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }).strict();

const TokenParam = z.object({ token: z.string().min(1).max(200) });
const NonceParam = z.object({ nonce: z.string().min(1).max(100) });

const TOKEN_PARAM_SCHEMA = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', description: 'The `chk_test_…` / `chk_live_…` token from the page URL.' } },
} as const;

const NOT_FOUND = 'CHECKOUT_SESSION_NOT_FOUND — no checkout page exists for this token.';
const RATE_LIMITED = 'RATE_LIMITED — too many requests for this checkout or from this address. Honour Retry-After.';

/** A bucket key that never holds the raw token. */
function tokenBucket(prefix: string) {
  return (req: FastifyRequest): string => {
    const raw = (req.params as { token?: unknown }).token;
    const digest = createHash('sha256').update(typeof raw === 'string' ? raw : '').digest('hex').slice(0, 32);
    return `${prefix}:${digest}`;
  };
}

/**
 * A browser may only POST here from the portal. The portal's own server calls
 * send no Origin at all.
 */
function assertPortalOrigin(req: FastifyRequest): void {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (origin !== portalBaseOrigin()) {
    throw new RekeyError({
      statusCode: 403,
      code: 'ORIGIN_NOT_ALLOWED',
      message: 'This checkout endpoint accepts requests from the hosted portal only.',
      fix: 'Call it from the Rekey checkout page, not from another site.',
    });
  }
}

export async function checkoutSessionRoutes(app: FastifyInstance): Promise<void> {
  const perIpCeiling = app.createRateLimit({
    max: globalRateLimitMax(env.RATE_LIMIT_MAX),
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => `ckip:${req.ip}`,
  });
  const ipCeiling = async (req: FastifyRequest): Promise<void> => {
    if (!req.clientIpVouched) return;
    const result = await perIpCeiling(req);
    if (result.isAllowed || !result.isExceeded) return;
    throw rateLimitedAfter(result.ttl, result.max);
  };

  app.get(
    '/:token',
    {
      onRequest: ipCeiling,
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: tokenBucket('ckview') } },
      schema: {
        tags: ['Public · Checkout'],
        security: [],
        summary: 'What the hosted checkout page may show for one session',
        description:
          'Returns the order summary, the buyer email and the browser configuration for the ' +
          "processor's component while the session is open or confirming. A complete or expired " +
          'session returns only `status` and `returnUrl`. A session whose payment mode no longer ' +
          "matches its provider's credentials is expired and refused with CHECKOUT_MODE_MISMATCH.",
        params: TOKEN_PARAM_SCHEMA,
        response: {
          200: ok(ref('CheckoutPageView'), 'The checkout page view.'),
          ...errs({
            404: NOT_FOUND,
            409: 'CHECKOUT_MODE_MISMATCH — the session was started in test mode and the credentials are now live, or the reverse.',
            429: RATE_LIMITED,
          }),
        },
      },
    },
    async (req) => {
      const { token } = TokenParam.parse(req.params);
      return { success: true, data: await checkoutPageView(token) };
    },
  );

  app.get(
    '/:token/status',
    {
      onRequest: ipCeiling,
      // The page polls every 2 s for about 20 s after the processor says yes.
      config: { rateLimit: { max: 40, timeWindow: '1 minute', keyGenerator: tokenBucket('ckstatus') } },
      schema: {
        tags: ['Public · Checkout'],
        security: [],
        summary: 'Poll one checkout session',
        description: '`open`, `confirming` (the processor said yes; waiting for its webhook), `complete` or `expired`.',
        params: TOKEN_PARAM_SCHEMA,
        response: {
          200: ok(
            {
              type: 'object',
              required: ['status'],
              properties: { status: { type: 'string', enum: ['open', 'confirming', 'complete', 'expired'] } },
            },
            'The session status.',
          ),
          ...errs({ 404: NOT_FOUND, 409: 'CHECKOUT_MODE_MISMATCH — see GET /:token.', 429: RATE_LIMITED }),
        },
      },
    },
    async (req) => {
      const { token } = TokenParam.parse(req.params);
      return { success: true, data: await checkoutStatus(token) };
    },
  );

  app.post(
    '/:token/fallback',
    {
      onRequest: ipCeiling,
      config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: tokenBucket('ckfallback') } },
      schema: {
        tags: ['Public · Checkout'],
        security: [],
        summary: "The processor's own page for this checkout",
        description:
          'For the "Continue on PayPal" link when the processor\'s script does not load. Only an ' +
          "https URL on the processor's own host is returned.",
        params: TOKEN_PARAM_SCHEMA,
        response: {
          200: ok(
            { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
            "The processor's hosted page for this order.",
          ),
          ...errs({
            403: 'ORIGIN_NOT_ALLOWED — a browser called this from a site other than the hosted portal.',
            404: NOT_FOUND,
            409:
              'CHECKOUT_SESSION_COMPLETE / CHECKOUT_SESSION_EXPIRED — the checkout can no longer be ' +
              'paid; CHECKOUT_FALLBACK_UNAVAILABLE — no processor page was recorded; or CHECKOUT_MODE_MISMATCH.',
            429: RATE_LIMITED,
          }),
        },
      },
    },
    async (req) => {
      assertPortalOrigin(req);
      const { token } = TokenParam.parse(req.params);
      return { success: true, data: await checkoutFallbackUrl(token) };
    },
  );

  app.post(
    '/:token/paypal/approved',
    {
      onRequest: ipCeiling,
      config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: tokenBucket('ckapprove') } },
      schema: {
        tags: ['Public · Checkout'],
        security: [],
        summary: "Report PayPal's approval from the checkout page",
        description:
          'Reads the subscription back from PayPal and moves the session to `confirming` only when ' +
          "it is this session's subscription, on this session's plan and buyer, approved at PayPal. " +
          "Activates nothing: the subscription activates from PayPal's webhook. Idempotent.",
        params: TOKEN_PARAM_SCHEMA,
        body: {
          type: 'object',
          required: ['subscriptionId'],
          additionalProperties: false,
          properties: { subscriptionId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9-]+$' } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              required: ['status'],
              properties: { status: { type: 'string', enum: ['confirming', 'complete'] } },
            },
            'The session status after the approval was checked.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — the body is not `{ subscriptionId }`.',
            403: 'ORIGIN_NOT_ALLOWED — a browser called this from a site other than the hosted portal.',
            404: NOT_FOUND,
            409:
              'CHECKOUT_CONFIRMATION_REFUSED — PayPal does not confirm this approval for this checkout; ' +
              'CHECKOUT_CONFIRMATION_LIMIT — too many refused confirmations, start again; ' +
              'CHECKOUT_SESSION_EXPIRED; or CHECKOUT_MODE_MISMATCH.',
            429: RATE_LIMITED,
          }),
        },
      },
    },
    async (req) => {
      assertPortalOrigin(req);
      const { token } = TokenParam.parse(req.params);
      const { subscriptionId } = ApprovedBody.parse(req.body);
      return { success: true, data: await confirmPaypalApproval(token, subscriptionId) };
    },
  );
}

/** The portal's half of readiness check 1. Registered under /api/v1/checkout. */
export async function checkoutProbeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/probe/:nonce',
    {
      config: { rateLimit: { max: globalRateLimitMax(30), timeWindow: '1 minute', allowList: skipUnvouchedIp } },
      schema: {
        tags: ['Public · Checkout'],
        security: [],
        summary: 'Readiness probe callback from the hosted portal',
        description:
          'The API minted this single-use nonce and asked the portal to call back with it. ' +
          'Answers the slug it was minted for once; a second call, or an unknown nonce, is 404.',
        params: { type: 'object', required: ['nonce'], properties: { nonce: { type: 'string' } } },
        response: {
          200: ok({ type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } }, 'The probed slug.'),
          ...errs({ 404: 'CHECKOUT_PROBE_NOT_FOUND — unknown, expired or already used.', 429: RATE_LIMITED }),
        },
      },
    },
    async (req) => {
      const { nonce } = NonceParam.parse(req.params);
      const slug = await confirmProbeNonce(nonce);
      if (slug === null) {
        throw new RekeyError({
          statusCode: 404,
          code: 'CHECKOUT_PROBE_NOT_FOUND',
          message: 'No readiness probe is waiting for this nonce.',
          fix: 'Run the checks again in Panel → Application → Billing → Checkout page.',
        });
      }
      return { success: true, data: { slug } };
    },
  );
}
