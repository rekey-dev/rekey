/**
 * Hosted customer portal — public config endpoint.
 *
 * `GET /api/v1/portal/config/:slug` is how the ReliPay-hosted portal
 * (portal.relipay.dev/<slug>) bootstraps itself: given the slug from the URL,
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
import { RelipayError } from '../../lib/error.js';
import { BillingConfigSchema } from '@relipay/shared-types';

const SlugParam = z.object({ slug: z.string().min(1).max(120) });

export async function portalConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/config/:slug',
    {
      schema: {
        tags: ['Public · Portal'],
        summary: 'Public config for the hosted customer portal of one Application',
        description:
          'Returns { slug, name, publishableKey, billingEnabled, branding } when the app has ' +
          'opted into the hosted portal. 404 otherwise (existence-hiding).',
        params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
      },
    },
    async (req) => {
      const { slug } = SlugParam.parse(req.params);
      const application = await prisma.application.findUnique({ where: { slug } });
      if (!application || !application.hostedPortalEnabled) {
        throw new RelipayError({
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
