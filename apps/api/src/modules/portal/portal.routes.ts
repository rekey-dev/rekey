/**
 * Hosted customer portal, public config endpoint.
 *
 * `GET /api/v1/portal/config/:slug` is how the Rekey-hosted portal
 * (portal.rekey.dev/<slug>) bootstraps itself: given the slug from the URL,
 * it returns the **public** facts a browser portal needs, the app name, its
 * **publishable** key (public by design), whether billing is on, and branding.
 * No secret material. Unauthenticated by design (the portal is signed-out at
 * this point); the publishable key it returns is itself a public credential.
 *
 * `GET /api/v1/portal/config?host=<hostname>` is the same for a portal served
 * on a custom domain. Only a VERIFIED domain matches, and only exactly: an
 * unverified claim can name any domain, so matching one would let an
 * Application serve its portal on a host it does not control.
 *
 * Returns 404 (not 403) when the app doesn't exist OR hasn't opted into the
 * hosted portal, same response either way, so a disabled portal can't be told
 * apart from a non-existent slug.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Application } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { normalisePortalDomain } from '../applications/portal-domain.js';
import { RekeyError } from '../../lib/error.js';
import { AuthConfigSchema, BillingConfigSchema } from '@rekey.dev/shared-types';
import { authMethodEnabled } from '../auth/auth.service.js';
import { signupAllowed } from '../../lib/signup-policy.js';
import { ok, errs, type JsonSchema } from '../../lib/openapi.js';
import { env } from '../../config/env.js';
import {
  globalRateLimitMax,
  portalConfigRateLimitKey,
  rateLimitedAfter,
  skipUnvouchedIp,
} from '../../lib/rate-limit.js';

/** `data` for `GET /config/:slug`, no registered component matches this projection. */
const PortalConfig: JsonSchema = {
  type: 'object',
  properties: {
    slug: { type: 'string' },
    name: { type: 'string' },
    publishableKey: { type: 'string', description: 'Public by design, safe to ship in a browser bundle.' },
    billingEnabled: { type: 'boolean' },
    billingSubject: {
      type: 'string',
      enum: ['user', 'org'],
      description: "'user' = individuals self-serve; 'org' = billing is per-team.",
    },
    branding: { type: 'object', additionalProperties: true },
    auth: {
      type: 'object',
      description: 'Which sign-in paths the portal may offer. Booleans only: this endpoint is anonymous.',
      properties: {
        password: { type: 'boolean', description: 'Email and password sign-in is enabled.' },
        magicLink: { type: 'boolean', description: 'Magic-link sign-in is enabled.' },
        signup: { type: 'boolean', description: 'A browser (publishable key) may self sign-up.' },
        emailVerificationRequired: { type: 'boolean' },
        mfaRequired: { type: 'boolean', description: 'Every user must enrol a second factor.' },
        devices: {
          type: 'boolean',
          description: 'Sign-in is bound to a device (`deviceBinding: required`), so the portal may offer a devices page.',
        },
        organizations: {
          type: 'boolean',
          description:
            'Customers may create organizations (`organizationsEnabled`), so the portal offers its organization page to all of them.',
        },
      },
      required: ['password', 'magicLink', 'signup', 'emailVerificationRequired', 'mfaRequired', 'devices', 'organizations'],
    },
  },
  required: ['slug', 'name', 'publishableKey', 'billingEnabled', 'billingSubject', 'branding', 'auth'],
};

const SlugParam = z.object({ slug: z.string().min(1).max(120) });
const HostQuery = z.object({ host: z.string().min(1).max(253) });

export async function portalConfigRoutes(app: FastifyInstance): Promise<void> {
  // Per-IP ceiling across ALL slugs and hosts, at the anonymous budget. Each
  // route's own bucket is per (slug or host, IP), so without this each guess
  // would open a fresh bucket and the routes would enumerate at no cost.
  const perIpCeiling = app.createRateLimit({
    max: globalRateLimitMax(env.RATE_LIMIT_MAX),
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => `portalip:${req.ip}`,
  });
  const ipCeiling = async (req: FastifyRequest): Promise<void> => {
    // Only a vouched client address; behind an unidentified proxy the
    // address is every visitor's, and the per-slug bucket is skipped too.
    if (!req.clientIpVouched) return;
    const result = await perIpCeiling(req);
    if (result.isAllowed || !result.isExceeded) return;
    throw rateLimitedAfter(result.ttl, result.max);
  };

  app.get(
    '/config/:slug',
    {
      onRequest: ipCeiling,
      // Unauthenticated by design, but tightened so it isn't a cheap oracle for
      // enumerating which Application slugs exist on a deployment. The
      // publishable key it returns is public by design (it ships in browser
      // bundles), so this is about discovery volume, not the key itself, a
      // real portal visitor makes one call per page load, not thousands.
      // Keyed on (slug, client IP). Per visitor only because the portal
      // forwards a visitor IP the API trusts from the portal's fixed address;
      // see `portalConfigRateLimitKey`.
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: portalConfigRateLimitKey,
          allowList: skipUnvouchedIp,
        },
      },
      schema: {
        tags: ['Public · Portal'],
        security: [],
        summary: 'Public config for the hosted customer portal of one Application',
        description:
          'Returns { slug, name, publishableKey, billingEnabled, billingSubject, branding, auth } when the app has ' +
          'opted into the hosted portal. 404 otherwise (existence-hiding).',
        params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
        response: {
          200: ok(PortalConfig, 'Public config for this application\'s hosted portal.'),
          ...errs({
            400: 'VALIDATION_ERROR: the slug exceeds 120 characters.',
            404:
              'PORTAL_NOT_FOUND: no application with that slug, the application has not ' +
              'opted into the hosted portal, or the application itself is disabled (the same ' +
              'response in all three cases, so none can be told apart from a non-existent ' +
              'slug).',
            429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      return portalConfig(await prisma.application.findUnique({ where: { slug } }));
    },
  );

  app.get(
    '/config',
    {
      onRequest: ipCeiling,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: portalConfigRateLimitKey,
          allowList: skipUnvouchedIp,
        },
      },
      schema: {
        tags: ['Public · Portal'],
        security: [],
        summary: 'Public config for the hosted customer portal served on a custom domain',
        description:
          'The same payload as `/config/{slug}`, for the Application whose VERIFIED portal domain is exactly ' +
          '`host` (case-insensitive, no port). `slug` in the payload maps the host to its Application. 404 otherwise ' +
          '(existence-hiding): an unverified or lapsed domain never matches, and neither does a parent or child domain.',
        querystring: {
          type: 'object',
          required: ['host'],
          properties: { host: { type: 'string', description: 'The hostname the visitor requested, e.g. billing.yourapp.com.' } },
        },
        response: {
          200: ok(PortalConfig, "Public config for this application's hosted portal."),
          ...errs({
            400: 'VALIDATION_ERROR: `host` is missing or exceeds 253 characters.',
            404:
              'PORTAL_NOT_FOUND: no application has verified that domain, its portal is off, or it is ' +
              'disabled (the same response in every case).',
            429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const { host } = HostQuery.parse(req.query);
      let domain: string;
      try {
        domain = normalisePortalDomain(host);
      } catch {
        return portalConfig(null);
      }
      return portalConfig(
        await prisma.application.findFirst({
          where: { portalDomain: domain, portalDomainVerifiedAt: { not: null } },
        }),
      );
    },
  );
}

function portalConfig(application: Application | null): { success: true; data: Record<string, unknown> } {
  // `disabledAt` joins the existing non-disclosure: a disabled Application
  // serves no portal, and this endpoint is unauthenticated, so it must not
  // become an oracle for which slugs exist and are merely switched off.
  if (!application || !application.hostedPortalEnabled || application.disabledAt !== null) {
    throw new RekeyError({
      statusCode: 404,
      code: 'PORTAL_NOT_FOUND',
      message: 'No hosted portal is available for this address.',
      fix: 'Check the URL. If you are the operator, enable the portal in Panel → Application → Billing → Portal.',
    });
  }
  const billing = BillingConfigSchema.parse(application.billingConfig);
  const authConfig = AuthConfigSchema.parse(application.authConfig);
  return {
    success: true,
    data: {
      slug: application.slug,
      name: application.name,
      publishableKey: application.publicKey,
      billingEnabled: billing.enabled,
      // 'user' = individuals self-serve; 'org' = billing is per-team, so the
      // portal can't run an individual checkout without an organization.
      billingSubject: billing.billingSubject ?? 'user',
      branding: application.portalBranding ?? {},
      auth: {
        password: authMethodEnabled(authConfig, 'password'),
        magicLink: authMethodEnabled(authConfig, 'magic_link'),
        signup: signupAllowed(authConfig, 'publishable', null),
        emailVerificationRequired: authConfig.requireEmailVerification,
        mfaRequired: authConfig.mfa === 'required',
        devices: authConfig.deviceBinding === 'required',
        organizations: authConfig.organizationsEnabled,
      },
    },
  };
}
