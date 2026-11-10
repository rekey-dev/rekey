/**
 * The signed-in header's sections. Adding a page to the nav is one entry here.
 *
 * Pure and runtime-neutral: the layout reads it, and tests import it directly.
 */

import type { PortalConfig } from './config';

/** What a section may ask of the signed-in customer. */
export interface PortalNavSession {
  user: { email: string; activeOrganizationId?: string | null };
}

export interface PortalNavItem {
  /** Path under `/<slug>`, starting with `/`, or `''` for the overview. */
  href: string;
  label: string;
  show(config: PortalConfig, session: PortalNavSession): boolean;
}

/**
 * @example
 * { href: '/security', label: 'Security', show: () => true },
 */
export const PORTAL_NAV: readonly PortalNavItem[] = [
  { href: '', label: 'Overview', show: () => true },
  { href: '/devices', label: 'Devices', show: (config) => config.auth.devices },
  { href: '/security', label: 'Security', show: () => true },
  { href: '/profile', label: 'Profile', show: () => true },
  {
    href: '/organization',
    label: 'Organization',
    // A customer who belongs to an organization reaches it through one of these: the
    // application bills or creates organizations, or the session acts for one.
    show: (config, session) =>
      config.billingSubject === 'org' || config.auth.organizations || Boolean(session.user.activeOrganizationId),
  },
];

/**
 * The sections this customer sees, as absolute paths.
 *
 * @example
 * portalNav('acme', config, session); // [{ href: '/acme', label: 'Overview', exact: true }, ...]
 */
export function portalNav(
  slug: string,
  config: PortalConfig,
  session: PortalNavSession,
): Array<{ href: string; label: string; exact: boolean }> {
  return PORTAL_NAV.filter((item) => item.show(config, session)).map((item) => ({
    href: `/${slug}${item.href}`,
    label: item.label,
    exact: item.href === '',
  }));
}
