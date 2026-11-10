/**
 * Where the visitor sees this Application's portal: its verified custom domain
 * when the request arrived on one, else the shared host plus the slug.
 */

import 'server-only';
import { headers } from 'next/headers';
import { portalBaseUrl } from './env';
import { PORTAL_HOST_HEADER, customDomainOrigin, domainName } from './portal-host';

/** The custom domain this request arrived on, as the middleware resolved it, or null. */
export async function portalCustomHost(): Promise<string | null> {
  try {
    return domainName((await headers()).get(PORTAL_HOST_HEADER));
  } catch {
    // Outside a request (build, tests): the shared host.
    return null;
  }
}

/**
 * The absolute URL of this Application's portal home, for a link the API emails
 * or returns the visitor to. No trailing slash.
 *
 * @example
 * await portalPublicBase('acme'); // 'https://portal.example.com/acme' on the shared host
 * await portalPublicBase('acme'); // 'https://billing.acme.com' on its custom domain
 */
export async function portalPublicBase(slug: string): Promise<string> {
  const domain = await portalCustomHost();
  return domain ? customDomainOrigin(domain) : `${portalBaseUrl()}/${slug}`;
}

/** The origin the visitor is on, for the `Origin` of a publishable-key call. */
export async function portalPublicOrigin(): Promise<string> {
  const domain = await portalCustomHost();
  return domain ? customDomainOrigin(domain) : new URL(portalBaseUrl()).origin;
}
