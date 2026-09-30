/**
 * Where do transactional emails link back to?
 *
 * Every customer-facing email that carries a call-to-action needs the base
 * URL of the CUSTOMER's own application. Historically the fallback was the
 * literal string `https://your-app.example.com`, a placeholder domain that
 * shipped to real inboxes as a dead "Get started" button.
 *
 * The obvious fix (drop the fallback) is a trap: `renderTemplate` replaces an
 * unknown `{{var}}` with the EMPTY STRING, never the literal token, so an
 * absent `appUrl` produces `href=""`, still a broken link, just a quieter
 * one. So this module has a partner rule in `modules/email/render.ts`: when
 * no URL resolves, the button is not rendered at all.
 *
 * Resolution order, first hit wins:
 *
 *   1. `explicit`, what the SDK caller passed (`input.appUrl`, `resetUrl`, …).
 *      The caller knows best; this has always been supported.
 *   2. `authConfig.appUrl`, the per-Application setting an operator edits in
 *      the panel (Applications → Auth → Application URL).
 *   3. The ORIGIN of `authConfig.redirectUrls[0]`, an inferred default. Those
 *      URLs are already the customer's own app, vetted by the operator as the
 *      post-sign-in redirect allowlist, so their origin is a safe guess.
 *   4. `DEFAULT_APP_URL`, deployment-wide env. Unset by default, so
 *      self-hosted behaviour is unchanged unless the operator opts in.
 *   5. `null`, nothing resolvable. Callers must then omit the URL variable
 *      entirely so the template drops the button.
 *
 * Every candidate is validated as an absolute http(s) URL; an unparseable or
 * non-http one is skipped rather than trusted, so a junk value in a jsonb
 * column degrades to the next rung instead of emitting a broken href.
 */

import type { Application } from '@prisma/client';
import { env } from '../config/env.js';
import { RekeyError } from './error.js';
import { hostedPortalUrl } from './portal-origins.js';

/**
 * Parse a candidate as an absolute http(s) URL and normalise it to an origin
 * + path with no trailing slash. Returns null for anything else, including
 * `javascript:` and `data:` URLs, which must never reach an email href.
 */
function normalise(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return trimmed.replace(/\/+$/, '');
}

/** Just the scheme + host (+ port) of a candidate URL, or null. */
function originOf(candidate: unknown): string | null {
  const normalised = normalise(candidate);
  if (normalised === null) return null;
  try {
    return new URL(normalised).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the base URL for links in this Application's emails, or null when
 * nothing usable is configured.
 *
 * `explicit` is whatever the API caller supplied for this specific send.
 */
export function resolveAppUrl(
  application: Pick<Application, 'authConfig'>,
  explicit?: string | null,
): string | null {
  const fromCaller = normalise(explicit);
  if (fromCaller !== null) return fromCaller;

  const authConfig = (application.authConfig ?? {}) as {
    appUrl?: unknown;
    redirectUrls?: unknown;
  };

  const configured = normalise(authConfig.appUrl);
  if (configured !== null) return configured;

  // Inferred: the origin of the first redirect URL the operator allowlisted.
  const redirectUrls = Array.isArray(authConfig.redirectUrls) ? authConfig.redirectUrls : [];
  for (const url of redirectUrls) {
    const origin = originOf(url);
    if (origin !== null) return origin;
  }

  return normalise(env.DEFAULT_APP_URL);
}

/**
 * Build a token-bearing link on top of the resolved base, e.g.
 * `https://app.acme.com/reset?token=…`.
 *
 * Returns the EMPTY STRING when no base resolves. That is the signal the
 * templates key off: `{{#if resetUrl}}` is false for an empty value, so the
 * button disappears instead of rendering `href=""`. Callers pass the result
 * straight through as the template variable.
 *
 * `path` must start with `/`. The token is URL-encoded here so callers can't
 * forget to.
 */
export function buildTokenUrl(base: string | null, path: string, token: string): string {
  if (base === null) return '';
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

/**
 * The origins an Application has declared as its own: `authConfig.appUrl` plus
 * every `authConfig.redirectUrls` entry, each reduced to its origin so
 * per-environment paths need no separate registration.
 *
 * @example
 * registeredOrigins({ authConfig: { appUrl: 'https://app.acme.com/home' } });
 * // Set { 'https://app.acme.com' }
 */
export function registeredOrigins(application: { authConfig?: unknown }): Set<string> {
  const authConfig = (application.authConfig ?? {}) as {
    appUrl?: unknown;
    redirectUrls?: unknown;
  };
  const declared = [
    typeof authConfig.appUrl === 'string' ? authConfig.appUrl : null,
    ...(Array.isArray(authConfig.redirectUrls) ? authConfig.redirectUrls : []),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  const allowed = new Set<string>();
  for (const d of declared) {
    try {
      allowed.add(new URL(d).origin);
    } catch {
      // A malformed stored value allows nothing rather than everything.
    }
  }
  return allowed;
}

/** What the token-URL guard reads from an Application. */
export type TokenUrlApplication = { authConfig?: unknown } & Partial<
  Pick<Application, 'slug' | 'hostedPortalEnabled' | 'portalDomain' | 'portalDomainVerifiedAt'>
>;

/**
 * Path shapes a server or browser could resolve to a different route than the
 * one the prefix check saw: dot segments (plain or percent-encoded), encoded
 * slashes and backslashes, raw backslashes and empty segments.
 */
const AMBIGUOUS_PATH = /%2e|%2f|%5c|\\|\/\/|(^|\/)\.{1,2}(\/|$)/i;

/** The path of an absolute URL string as written, before the URL parser resolves it. */
function rawPath(url: string): string {
  const withoutAuthority = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*/i, '');
  return withoutAuthority.split(/[?#]/, 1)[0] ?? '';
}

/**
 * Whether `url` points inside THIS Application's own hosted portal, while the
 * portal is on.
 *
 * The shared portal host serves every Application under `/<slug>`, so its
 * origin alone would let one app mail a live token into another app's portal
 * pages. The check is scoped to this app's slug, and the path must be exactly
 * what the parser produced (nothing resolved away) with no dot segment,
 * encoded separator or empty segment, so `/<slug>/../<other>` and its encoded
 * forms are refused instead of normalised into a pass.
 *
 * A verified custom portal domain belongs to this app alone, so its origin is
 * enough. An unverified one could still be pointed anywhere, so it is not.
 */
function isOwnPortalUrl(application: TokenUrlApplication, url: string, candidate: URL): boolean {
  if (application.hostedPortalEnabled !== true) return false;

  if (
    application.portalDomain &&
    application.portalDomainVerifiedAt &&
    candidate.origin === `https://${application.portalDomain}`
  ) {
    return true;
  }

  if (!application.slug) return false;
  const portal = hostedPortalUrl({ slug: application.slug, hostedPortalEnabled: true });
  if (portal === null) return false;
  const root = new URL(portal);
  if (candidate.origin !== root.origin) return false;

  const path = rawPath(url);
  if (path !== candidate.pathname || AMBIGUOUS_PATH.test(path)) return false;
  return path === root.pathname || path.startsWith(`${root.pathname}/`);
}

/**
 * Refuse a caller-supplied email link that points somewhere this Application
 * has not declared.
 *
 * The reset, magic-link and verification routes accept a `{token}` template
 * from the caller and render it into an `<a href>` in an email we send, with
 * our branding and our SPF/DKIM. The URL was validated only for being
 * parseable, no scheme check, no origin check, and all three routes accept
 * the PUBLISHABLE key, which is public by design and served unauthenticated by
 * the portal config endpoint.
 *
 * So anyone could ask us to mail a victim a genuine, correctly-branded,
 * deliverable message whose button carried a live single-use session token to
 * a domain they controlled. One click was a full account takeover, and every
 * signal a careful user checks, sender, branding, authentication headers,
 * said the mail was legitimate, because it was.
 *
 * `authConfig.redirectUrls` already existed for exactly this and was enforced
 * nowhere: its only reader treated it as a source of defaults.
 *
 * Allowed destinations:
 * - the Application's own `appUrl` and `redirectUrls`, compared by ORIGIN, so
 *   an operator can keep using per-environment paths without registering each;
 * - its own hosted portal while the portal is on (see `isOwnPortalUrl`). Rekey
 *   runs those pages, so the operator never has to register them.
 *
 * An Application with none of these has nothing to compare against, so a
 * caller-supplied URL is refused outright, fail closed, because the
 * alternative is the hole above.
 */
export function assertAllowedTokenUrl(
  application: TokenUrlApplication,
  url: string | undefined,
  field: string,
): void {
  if (url === undefined) return;

  let candidate: URL;
  try {
    candidate = new URL(url);
  } catch {
    throw new RekeyError({
      statusCode: 400,
      code: 'AUTH_URL_INVALID',
      message: `\`${field}\` is not a valid URL.`,
      fix: 'Pass an absolute URL on an origin this Application has registered.',
    });
  }

  // http(s) only. A `javascript:` or `data:` href in an email is inert in most
  // clients and live in some, and neither is ever a legitimate answer here.
  if (candidate.protocol !== 'https:' && candidate.protocol !== 'http:') {
    throw new RekeyError({
      statusCode: 400,
      code: 'AUTH_URL_NOT_ALLOWED',
      message: `\`${field}\` must be an http(s) URL.`,
      fix: 'Pass an absolute http(s) URL on a registered origin.',
    });
  }

  // `https://attacker.tld@app.example.com` keeps the registered origin but
  // reads as another host to the person clicking it. Checked before either
  // allowance, so a portal URL cannot carry credentials either.
  if (candidate.username !== '' || candidate.password !== '') {
    throw new RekeyError({
      statusCode: 400,
      code: 'AUTH_URL_NOT_ALLOWED',
      message: `\`${field}\` must not contain credentials (a user or password before the host).`,
      fix: 'Remove everything between `://` and `@`, and pass the plain URL on a registered origin.',
    });
  }

  if (registeredOrigins(application).has(candidate.origin)) return;
  if (isOwnPortalUrl(application, url, candidate)) return;

  throw new RekeyError({
    statusCode: 400,
    code: 'AUTH_URL_NOT_ALLOWED',
    message: `\`${field}\` points at ${candidate.origin}, which this Application has not registered.`,
    fix:
      'Add the origin to the Application\'s redirect URLs (Panel → Application → Auth methods), ' +
      'or set its App URL. This link is emailed to your users carrying a login token, so it is ' +
      'refused rather than sent somewhere unrecognised.',
  });
}
