/**
 * Browser origins the Rekey-hosted customer portal (Portal V2) calls an
 * Application's publishable API from. Auto-allowed for publishable-key requests
 * so operators don't have to hand-add the portal host to their CORS origins.
 */

import type { Application } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * Origin of the shared hosted-portal host, or null when this deployment does
 * not run one. PUBLIC_PORTAL_URL has no default, a Rekey default would have
 * pointed a self-hoster's END USERS at our infrastructure, so "unset" is a
 * real state meaning "no hosted portal here", not a misconfiguration.
 */
export function portalBaseOrigin(): string | null {
  if (!env.PUBLIC_PORTAL_URL) return null;
  return new URL(env.PUBLIC_PORTAL_URL).origin;
}

/**
 * Where an Application's end users manage their billing: the shared portal
 * host plus the slug, or null when the Application has not enabled the hosted
 * portal or this deployment runs none.
 *
 * @example
 * hostedPortalUrl({ slug: 'acme', hostedPortalEnabled: true }); // 'https://portal.rekey.dev/acme'
 */
export function hostedPortalUrl(app: Pick<Application, 'slug' | 'hostedPortalEnabled'>): string | null {
  const base = portalBaseOrigin();
  return app.hostedPortalEnabled && base !== null ? `${base}/${encodeURIComponent(app.slug)}` : null;
}

/**
 * Origins from which the hosted portal may call THIS app's publishable API:
 * the shared portal host (when the app opted in) plus its verified custom
 * domain. Empty when the app hasn't enabled the hosted portal.
 */
export function portalOriginsForApp(
  app: Pick<Application, 'hostedPortalEnabled' | 'portalDomain' | 'portalDomainVerifiedAt'>,
): string[] {
  if (!app.hostedPortalEnabled) return [];
  // A deployment with no hosted portal contributes no shared origin; a verified
  // custom domain still does.
  const base = portalBaseOrigin();
  const out = base ? [base] : [];
  if (app.portalDomain && app.portalDomainVerifiedAt) {
    out.push(`https://${app.portalDomain}`);
  }
  return out;
}
