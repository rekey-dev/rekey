/**
 * Resolve an Application's public portal config from its slug.
 *
 * Hits `GET /api/v1/portal/config/:slug` — unauthenticated, returns only public
 * facts (name, publishable key, billing flag, branding). 404 when the app
 * doesn't exist or hasn't enabled the hosted portal → we render notFound().
 */

import 'server-only';
import { cache } from 'react';
import { rekeyApiUrl } from './env';

export interface PortalBranding {
  /** Overrides the Application name in the portal header. */
  displayName?: string;
  /** Primary/brand color (any CSS color) — drives buttons + accents. */
  primaryColor?: string;
  /** Page background color (any CSS color). Falls back to a neutral default. */
  backgroundColor?: string;
  /** Card/surface color (any CSS color). Falls back to white. */
  surfaceColor?: string;
  /** Logo image URL shown in the header. */
  logoUrl?: string;
  /** One-line tagline under the title. */
  tagline?: string;
  /** Support contact email — rendered as a mailto: link in the footer/errors. */
  supportEmail?: string;
  /** Support page URL — takes precedence over supportEmail when both are set. */
  supportUrl?: string;
}

export interface PortalConfig {
  slug: string;
  name: string;
  publishableKey: string;
  billingEnabled: boolean;
  billingSubject: 'user' | 'org';
  branding: PortalBranding;
}

/**
 * Whitelist an operator-supplied CSS color before it's injected into an inline
 * `style` (a `--color-*` custom property). React HTML-escapes the attribute, so
 * there's no attribute breakout — but an unguarded value like `red;display:none`
 * would still inject extra declarations onto the element. Accept only hex,
 * rgb/rgba/hsl/hsla(), and bare named colors; anything else falls back to the
 * default token. Returns undefined for empty/invalid input.
 */
export function safeCssColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const s = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/i.test(s)) return s;
  if (/^[a-zA-Z]+$/.test(s)) return s; // named color (e.g. rebeccapurple)
  return undefined;
}

/**
 * Whitelist an operator-supplied image URL before it's rendered into an `<img
 * src>`. Only absolute http(s) URLs are allowed — this rejects `javascript:`,
 * `data:`, and other schemes an operator could set to phish their own customers
 * or smuggle a tracking payload. Returns undefined for empty/invalid input so
 * the caller can skip rendering the logo entirely.
 */
/**
 * Resolve the operator's support contact into a safe href: an http(s) URL when
 * supportUrl is set (validated), else a mailto: when supportEmail looks like an
 * email. Returns undefined when neither is usable — callers hide the link.
 */
export function supportLink(branding: PortalBranding): string | undefined {
  const url = safeHttpUrl(branding.supportUrl);
  if (url) return url;
  const email = branding.supportEmail?.trim();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return `mailto:${email}`;
  return undefined;
}

export function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Cached per-request so layout + page don't double-fetch. */
export const getPortalConfig = cache(async (slug: string): Promise<PortalConfig | null> => {
  const res = await fetch(`${rekeyApiUrl()}/api/v1/portal/config/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`portal config lookup failed for "${slug}" (HTTP ${res.status})`);
  }
  const json = (await res.json()) as { success: true; data: PortalConfig };
  return json.data;
});
