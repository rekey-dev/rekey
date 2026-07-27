/**
 * Browser origins the Rekey-hosted customer portal (Portal V2) calls an
 * Application's publishable API from. Auto-allowed for publishable-key requests
 * so operators don't have to hand-add the portal host to their CORS origins.
 */

import type { Application } from '@prisma/client';
import { env } from '../config/env.js';

/** Origin of the shared hosted-portal host, e.g. `https://portal.relipay.dev`. */
export function portalBaseOrigin(): string {
  return new URL(env.PUBLIC_PORTAL_URL).origin;
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
  const out = [portalBaseOrigin()];
  if (app.portalDomain && app.portalDomainVerifiedAt) {
    out.push(`https://${app.portalDomain}`);
  }
  return out;
}
