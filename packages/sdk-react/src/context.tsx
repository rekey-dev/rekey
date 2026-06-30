/**
 * RelipayProvider — wraps the app, exposes user + signed-in state.
 *
 * Two ways to feed it:
 *   1. Initial user + access token from your SSR (Next.js App Router server
 *      component): `<RelipayProvider initialUser={...} initialAccessToken={...}>`
 *   2. Fetch on mount: pass only `accessToken` — the provider calls
 *      getCurrentUser on mount + on token change.
 *
 * Auth state changes (sign-in, sign-out, refresh) are usually handled by
 * the customer's server (cookie rotation). Components here read from the
 * context, so they reflect whatever the server says about the user on the
 * next page load.
 */

import * as React from 'react';
import type { EndUserDto } from '@relipay/shared-types';
import { RelipayBrowserClient } from './client.js';

export interface RelipayContextValue {
  user: EndUserDto | null;
  signedIn: boolean;
  loading: boolean;
  client: RelipayBrowserClient;
  /** Manual refresh — re-fetch the current user. Useful after sign-in. */
  refresh: () => Promise<void>;
}

const Ctx = React.createContext<RelipayContextValue | null>(null);

export interface RelipayProviderProps {
  children: React.ReactNode;
  apiUrl: string;
  /**
   * Publishable key (`rp_pub_…`) for this Application. Enables the bootstrap
   * auth methods (sign-in/up, magic-link, passkey, license verify, plans) so a
   * browser-only app needs no backend. Safe to ship in client code — it only
   * identifies the app. Omit only if you sign users in server-side and just
   * read the current user here via `accessToken`.
   */
  publishableKey?: string;
  /** Pre-fetched user to seed initial render (typical SSR pattern). */
  initialUser?: EndUserDto | null;
  /** Token to use for client-side calls. Provider re-fetches user when this changes. */
  accessToken?: string | null;
  /** Override the /me-by-token endpoint your customer server proxies to ReliPay. */
  meEndpoint?: string;
}

export function RelipayProvider({
  children,
  apiUrl,
  publishableKey,
  initialUser = null,
  accessToken = null,
  meEndpoint,
}: RelipayProviderProps): React.JSX.Element {
  const client = React.useMemo(
    () =>
      new RelipayBrowserClient({
        apiUrl,
        ...(publishableKey !== undefined && { publishableKey }),
      }),
    [apiUrl, publishableKey],
  );
  const [user, setUser] = React.useState<EndUserDto | null>(initialUser);
  const [loading, setLoading] = React.useState<boolean>(initialUser === null && Boolean(accessToken));

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!accessToken) {
      setUser(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const u = await client.getCurrentUser(accessToken, meEndpoint);
      setUser(u);
    } catch {
      // Network or unknown error → treat as signed-out for UI purposes.
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [client, accessToken, meEndpoint]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: RelipayContextValue = React.useMemo(
    () => ({ user, signedIn: user !== null, loading, client, refresh }),
    [user, loading, client, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Internal — use the public hooks instead. */
export function useRelipayContext(): RelipayContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error(
      '@relipay/react: hooks must be used inside <RelipayProvider>. Wrap your app at the root.',
    );
  }
  return ctx;
}
