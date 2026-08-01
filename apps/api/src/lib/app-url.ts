/**
 * Where do transactional emails link back to?
 *
 * Every customer-facing email that carries a call-to-action needs the base
 * URL of the CUSTOMER's own application. Historically the fallback was the
 * literal string `https://your-app.example.com` — a placeholder domain that
 * shipped to real inboxes as a dead "Get started" button.
 *
 * The obvious fix (drop the fallback) is a trap: `renderTemplate` replaces an
 * unknown `{{var}}` with the EMPTY STRING, never the literal token, so an
 * absent `appUrl` produces `href=""` — still a broken link, just a quieter
 * one. So this module has a partner rule in `modules/email/render.ts`: when
 * no URL resolves, the button is not rendered at all.
 *
 * Resolution order, first hit wins:
 *
 *   1. `explicit` — what the SDK caller passed (`input.appUrl`, `resetUrl`, …).
 *      The caller knows best; this has always been supported.
 *   2. `authConfig.appUrl` — the per-Application setting an operator edits in
 *      the panel (Applications → Auth → Application URL).
 *   3. The ORIGIN of `authConfig.redirectUrls[0]` — an inferred default. Those
 *      URLs are already the customer's own app, vetted by the operator as the
 *      post-sign-in redirect allowlist, so their origin is a safe guess.
 *   4. `DEFAULT_APP_URL` — deployment-wide env. Unset by default, so
 *      self-hosted behaviour is unchanged unless the operator opts in.
 *   5. `null` — nothing resolvable. Callers must then omit the URL variable
 *      entirely so the template drops the button.
 *
 * Every candidate is validated as an absolute http(s) URL; an unparseable or
 * non-http one is skipped rather than trusted, so a junk value in a jsonb
 * column degrades to the next rung instead of emitting a broken href.
 */

import type { Application } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * Parse a candidate as an absolute http(s) URL and normalise it to an origin
 * + path with no trailing slash. Returns null for anything else — including
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
