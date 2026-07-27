/**
 * Portal environment wiring.
 *
 * The portal is operated by the Rekey deployment's operator and serves the
 * end-users of exactly ONE Application per deployment (v1 constraint — see
 * docs/portal.md). It authenticates to the API with that Application's
 * server-side secret key:
 *
 *   RELIPAY_URL         — base URL of the Rekey API (e.g. https://api.example.com)
 *   RELIPAY_SECRET_KEY  — Application secret key (rp_live_… / rp_test_…), server-only
 *   PORTAL_BASE_URL     — public URL of this portal (checkout return URLs);
 *                         defaults to http://localhost:3050
 *   PORTAL_APP_NAME     — optional display name shown in the header; falls
 *                         back to the Application's name from the API
 *
 * `@rekey.dev/nextjs/server` reads `RELIPAY_SECRET` — this module bridges the
 * portal's canonical `RELIPAY_SECRET_KEY` onto it before the SDK's lazy
 * client first constructs. Import this module (directly or via lib/relipay)
 * before any `@rekey.dev/nextjs/server` helper runs; lib/session and
 * lib/actions both do.
 */

import 'server-only';

if (!process.env.RELIPAY_SECRET && process.env.RELIPAY_SECRET_KEY) {
  process.env.RELIPAY_SECRET = process.env.RELIPAY_SECRET_KEY;
}

export function requireEnv(name: 'RELIPAY_URL' | 'RELIPAY_SECRET_KEY'): string {
  // RELIPAY_SECRET accepted as a fallback spelling for parity with
  // examples/nextjs-saas and @rekey.dev/nextjs.
  const value =
    process.env[name] ?? (name === 'RELIPAY_SECRET_KEY' ? process.env.RELIPAY_SECRET : undefined);
  if (!value) {
    throw new Error(
      `${name} is missing — set it in the portal's environment (see docs/portal.md).`,
    );
  }
  return value;
}

/** Public URL of this portal — used to build checkout success/cancel URLs. */
export function portalBaseUrl(): string {
  return process.env.PORTAL_BASE_URL ?? 'http://localhost:3050';
}
