import type { Application } from '@prisma/client';
import { RekeyError } from '../../lib/error.js';
import { sharedPortalUrl } from '../../lib/portal-origins.js';

/** The hosted portal page a provider sends the browser back to, under the portal's base for this Application. */
const PORTAL_RETURN_PATH = '/oauth/callback';

type PortalFacts = Pick<Application, 'slug' | 'hostedPortalEnabled' | 'portalDomain' | 'portalDomainVerifiedAt'>;

/**
 * The redirect URIs this Application's hosted portal may name in place of the
 * provider's configured one: its sign-in landing page on the shared portal
 * host, and on its verified custom domain. None while the portal is off.
 *
 * @example
 * portalReturnUrls({ slug: 'acme', hostedPortalEnabled: true, portalDomain: null, portalDomainVerifiedAt: null });
 * // ['https://portal.rekey.dev/acme/oauth/callback']
 */
export function portalReturnUrls(application: PortalFacts): string[] {
  if (!application.hostedPortalEnabled) return [];
  const shared = sharedPortalUrl(application.slug);
  const urls = shared === null ? [] : [`${shared}${PORTAL_RETURN_PATH}`];
  if (application.portalDomain && application.portalDomainVerifiedAt) {
    urls.push(`https://${application.portalDomain}${PORTAL_RETURN_PATH}`);
  }
  return urls;
}

/**
 * The redirect URI for this sign-in: the provider's configured one, or the
 * portal's landing page when the caller names it. Only an exact portal URL is
 * taken, and only for a provider the operator offers in the portal: until its
 * console lists the portal page, the provider would answer with its own
 * redirect error instead of a sign-in.
 *
 * @example
 * redirectUriFor(application, { name: 'google', configured: 'https://app.acme.com/cb', offeredInPortal: false }, undefined);
 * // 'https://app.acme.com/cb'
 */
export function redirectUriFor(
  application: PortalFacts,
  provider: { name: string; configured: string; offeredInPortal: boolean },
  requested: string | undefined,
): string {
  if (requested === undefined) return provider.configured;
  const allowed = portalReturnUrls(application);
  if (allowed.includes(requested)) {
    if (provider.offeredInPortal) return requested;
    throw new RekeyError({
      statusCode: 400,
      code: 'OAUTH_PROVIDER_NOT_IN_PORTAL',
      message: `"${provider.name}" is not offered in this Application's hosted portal.`,
      fix:
        `First add ${allowed.join(' and ')} as an authorized redirect URI in the ${provider.name} developer console. ` +
        `Then tick "Offer in the hosted portal" on ${provider.name} under Panel → Application → Authentication → ` +
        `Sign-in providers, or PUT /api/v1/tenant/applications/:id/oauth-config/${provider.name} with ` +
        "the provider's `clientId`, `clientSecret` and `redirectUri` plus `hostedPortal: true`.",
    });
  }
  throw new RekeyError({
    statusCode: 400,
    code: 'OAUTH_REDIRECT_URI_NOT_ALLOWED',
    message:
      allowed.length === 0
        ? '`redirectUri` may only name the hosted portal, and this Application has no hosted portal.'
        : `\`redirectUri\` must be this Application's hosted portal sign-in page: ${allowed.join(' or ')}.`,
    fix:
      allowed.length === 0
        ? 'Leave `redirectUri` out to use the redirect URI configured for this provider, or turn the hosted portal ' +
          'on for this Application (Panel → Application → Billing → Portal) and pass its sign-in page.'
        : 'Leave `redirectUri` out to use the redirect URI configured for this provider, or pass one of the URLs ' +
          'this message lists, exactly as written.',
  });
}
