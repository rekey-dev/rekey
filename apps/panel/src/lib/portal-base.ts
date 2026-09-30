/**
 * Origin of the hosted customer portal this deployment runs, or null when it
 * runs none.
 *
 * The API is the authority: it reports `portalBaseUrl` from its own
 * PUBLIC_PORTAL_URL, which is what portal links and password resets are
 * checked against. The panel's build-time NEXT_PUBLIC_PORTAL_URL is used only
 * when an older API does not send the field. There is never a placeholder:
 * a URL shown to the operator as live must be one customers can open.
 *
 * @example
 * portalBase({ portalBaseUrl: 'https://portal.example.com/' }); // 'https://portal.example.com'
 * portalBase({ portalBaseUrl: null }, 'https://portal.example.com'); // null
 */
export function portalBase(
  app: { portalBaseUrl?: string | null },
  buildTimeUrl: string | undefined = process.env.NEXT_PUBLIC_PORTAL_URL,
): string | null {
  const value = app.portalBaseUrl === undefined ? buildTimeUrl : app.portalBaseUrl;
  return value ? value.replace(/\/+$/, '') : null;
}
