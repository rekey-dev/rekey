/**
 * Runs once when the panel server starts (Next's instrumentation hook).
 *
 * Only a configuration check: warn about a proxy setting that would otherwise
 * fail silently. See `proxyConfigWarning` in `lib/client-ip.ts`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { proxyConfigWarning } = await import('@/lib/client-ip');
  const warning = proxyConfigWarning({
    PANEL_TRUSTED_PROXIES: process.env.PANEL_TRUSTED_PROXIES,
    PANEL_PROXY_SECRET: process.env.PANEL_PROXY_SECRET,
  });
  if (warning) console.warn(warning);
}
