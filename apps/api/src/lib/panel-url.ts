/**
 * Base origin the operator PANEL runs on — used to build operator-facing links
 * (OAuth redirect URI, magic-link + password-reset URLs in emails).
 *
 * `PANEL_OAUTH_REDIRECT_BASE` wins; otherwise the panel origin is inferred from
 * `CORS_ALLOWED_ORIGINS` (preferring a `panel.` host), so operator links work
 * without a second env in the common deployment. Returns null when nothing
 * usable resolves — callers then fall back to returning the raw token.
 */

import { env, corsAllowedOrigins } from '../config/env.js';

export function panelBaseUrl(): string | null {
  if (env.PANEL_OAUTH_REDIRECT_BASE) return env.PANEL_OAUTH_REDIRECT_BASE.replace(/\/$/, '');
  const panelHost = corsAllowedOrigins.find((o) => {
    try {
      return new URL(o).hostname.startsWith('panel.');
    } catch {
      return false;
    }
  });
  const chosen = panelHost ?? corsAllowedOrigins[0];
  return chosen ? chosen.replace(/\/$/, '') : null;
}
