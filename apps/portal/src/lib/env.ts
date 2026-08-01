/**
 * Portal V2 environment wiring.
 *
 * The hosted portal serves the end-users of ANY opted-in Application, resolved
 * by the `<slug>` in the URL (portal.rekey.dev/<slug>). It holds **no
 * per-app secret key** — it identifies each app by fetching that app's PUBLIC
 * config (incl. its publishable key) and authorizes users with their own token.
 *
 *   REKEY_URL      — base URL of the Rekey API (server-side fetches + the
 *                      publishable-key client both hit this).
 *   PORTAL_BASE_URL  — public URL of this portal (checkout return URLs).
 *                      Required in production: a wrong value sends a paying
 *                      customer somewhere that isn't this portal AFTER their
 *                      card is charged, so it fails loud rather than guessing.
 */

import 'server-only';

export function rekeyApiUrl(): string {
  const value = process.env.REKEY_URL;
  if (!value) {
    throw new Error('REKEY_URL is missing — set it in the portal environment (see docs/portal.md).');
  }
  return value.replace(/\/$/, '');
}

/**
 * Public base URL of this portal — used to build checkout success/cancel URLs.
 *
 * No production fallback. This value is handed to the payment provider as the
 * place to send the customer back to once they have paid; a localhost default
 * silently strands a real customer after a real charge. Outside production a
 * localhost default is the useful thing, so it is kept there and only there.
 */
export function portalBaseUrl(): string {
  const value = process.env.PORTAL_BASE_URL;
  if (!value) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'PORTAL_BASE_URL is missing — set it to this portal\'s public origin ' +
          '(e.g. https://portal.example.com). It builds the checkout return URLs, ' +
          'so an unset value strands customers after payment.',
      );
    }
    return 'http://localhost:3050';
  }
  return value.replace(/\/$/, '');
}
