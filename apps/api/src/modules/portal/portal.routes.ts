/**
 * Hosted customer portal — public config endpoint.
 *
 * `GET /api/v1/portal/config/:slug` is how the Rekey-hosted portal
 * (portal.rekey.dev/<slug>) bootstraps itself: given the slug from the URL,
 * it returns the **public** facts a browser portal needs — the app name, its
 * **publishable** key (public by design), whether billing is on, and branding.
 * No secret material. Unauthenticated by design (the portal is signed-out at
 * this point); the publishable key it returns is itself a public credential.
 *
 * Returns 404 (not 403) when the app doesn't exist OR hasn't opted into the
 * hosted portal — same response either way, so a disabled portal can't be told
 * apart from a non-existent slug.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import { ok, errs, type JsonSchema } from '../../lib/openapi.js';

/** `data` for `GET /config/:slug` — no registered component matches this projection. */
const PortalConfig: JsonSchema = {
  type: 'object',
  properties: {
    slug: { type: 'string' },
    name: { type: 'string' },
    publishableKey: { type: 'string', description: 'Public by design — safe to ship in a browser bundle.' },
    billingEnabled: { type: 'boolean' },
    billingSubject: {
      type: 'string',
      enum: ['user', 'org'],
      description: "'user' = individuals self-serve; 'org' = billing is per-team.",
    },
    branding: { type: 'object', additionalProperties: true },
  },
  required: ['slug', 'name', 'publishableKey', 'billingEnabled', 'billingSubject', 'branding'],
};

const SlugParam = z.object({ slug: z.string().min(1).max(120) });

export async function portalConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/config/:slug',
    {
      // Unauthenticated by design, but tightened so it isn't a cheap oracle for
      // enumerating which Application slugs exist on a deployment. The
      // publishable key it returns is public by design (it ships in browser
      // bundles), so this is about discovery volume, not the key itself — a
      // real portal visitor makes one call per page load, not thousands.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public · Portal'],
        security: [],
        summary: 'Public config for the hosted customer portal of one Application',
        description:
          'Returns { slug, name, publishableKey, billingEnabled, branding } when the app has ' +
          'opted into the hosted portal. 404 otherwise (existence-hiding).',
        params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
        response: {
          200: ok(PortalConfig, 'Public config for this application\'s hosted portal.'),
          ...errs({
            400: 'VALIDATION_ERROR — the slug exceeds 120 characters.',
            404:
              'PORTAL_NOT_FOUND — no application with that slug, the application has not ' +
              'opted into the hosted portal, or the application itself is disabled (the same ' +
              'response in all three cases, so none can be told apart from a non-existent ' +
              'slug).',
            429: 'RATE_LIMITED — too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await prisma.application.findUnique({ where: { slug } });
      // `disabledAt` joins the existing non-disclosure: a disabled Application
      // serves no portal, and this endpoint is unauthenticated, so it must not
      // become an oracle for which slugs exist and are merely switched off.
      if (!application || !application.hostedPortalEnabled || application.disabledAt !== null) {
        throw new RekeyError({
          statusCode: 404,
          code: 'PORTAL_NOT_FOUND',
          message: 'No hosted portal is available for this address.',
          fix: 'Check the URL. If you are the operator, enable the portal in Panel → Application → Portal.',
        });
      }
      const billing = BillingConfigSchema.parse(application.billingConfig);
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
        },
      };
    },
  );
}
