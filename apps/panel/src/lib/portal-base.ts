/**
 * Origin of the hosted customer portal this deployment runs, or null when it
 * runs none.
 *
 * The API is the authority: it reports `portalBaseUrl` from its own
 * PUBLIC_PORTAL_URL, which is what portal links and password resets are
 * checked against. There is no other source and never a placeholder: a URL
 * shown to the operator as live must be one customers can open.
 *
 * @example
 * portalBase({ portalBaseUrl: 'https://portal.example.com/' }); // 'https://portal.example.com'
 * portalBase({ portalBaseUrl: null }); // null
 */
export function portalBase(app: { portalBaseUrl?: string | null }): string | null {
  return app.portalBaseUrl ? app.portalBaseUrl.replace(/\/+$/, '') : null;
}
