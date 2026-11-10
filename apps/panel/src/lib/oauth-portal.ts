import type { ApplicationRow } from './api';

/** Providers whose usual app type takes a single callback host, so one app cannot serve both the operator's app and the portal. */
export const SINGLE_CALLBACK_HOST_PROVIDERS: ReadonlySet<string> = new Set(['github']);

/**
 * The hosted portal's social sign-in pages for this Application, as the API
 * accepts them: on the shared portal host, and on a verified custom domain.
 * Empty while the portal is off or the deployment runs none.
 *
 * @example
 * portalSignInUrls({ slug: 'acme', hostedPortalEnabled: true, portalBaseUrl: 'https://portal.rekey.dev' });
 * // ['https://portal.rekey.dev/acme/oauth/callback']
 */
export function portalSignInUrls(
  app: Pick<ApplicationRow, 'slug' | 'hostedPortalEnabled' | 'portalDomain' | 'portalDomainVerifiedAt' | 'portalBaseUrl'>,
): string[] {
  if (!app.hostedPortalEnabled) return [];
  const urls = app.portalBaseUrl ? [`${app.portalBaseUrl}/${encodeURIComponent(app.slug)}/oauth/callback`] : [];
  if (app.portalDomain && app.portalDomainVerifiedAt) urls.push(`https://${app.portalDomain}/oauth/callback`);
  return urls;
}
