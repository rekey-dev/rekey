/**
 * Portal V2 environment wiring.
 *
 * The hosted portal serves the end-users of ANY opted-in Application, resolved
 * by the `<slug>` in the URL (portal.relipay.dev/<slug>). It holds **no
 * per-app secret key** — it identifies each app by fetching that app's PUBLIC
 * config (incl. its publishable key) and authorizes users with their own token.
 *
 *   RELIPAY_URL      — base URL of the Rekey API (server-side fetches + the
 *                      publishable-key client both hit this).
 *   PORTAL_BASE_URL  — public URL of this portal (checkout return URLs);
 *                      defaults to http://localhost:3050.
 */

import 'server-only';

export function rekeyApiUrl(): string {
  const value = process.env.RELIPAY_URL;
  if (!value) {
    throw new Error('RELIPAY_URL is missing — set it in the portal environment (see docs/portal.md).');
  }
  return value.replace(/\/$/, '');
}

/** Public base URL of this portal — used to build checkout success/cancel URLs. */
export function portalBaseUrl(): string {
  return (process.env.PORTAL_BASE_URL ?? 'http://localhost:3050').replace(/\/$/, '');
}
