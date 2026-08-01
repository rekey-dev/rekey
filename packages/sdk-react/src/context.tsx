'use client';

/**
 * RekeyProvider — wraps the app, exposes user + signed-in state.
 *
 * Two ways to feed it:
 *   1. Initial user + access token from your SSR (Next.js App Router server
 *      component): `<RekeyProvider initialUser={...} accessToken={...}>` — the
 *      first render needs no fetch.
 *   2. Fetch on mount: pass only `accessToken` — the provider calls
 *      getCurrentUser on mount + on token change.
 *
 * Auth state changes (sign-in, sign-out, refresh) are usually handled by
 * the customer's server (cookie rotation). Components here read from the
 * context, so they reflect whatever the server says about the user on the
 * next page load.
 */

import * as React from 'react';
import type { EndUserDto } from '@rekey.dev/shared-types';
import { RekeyBrowserClient } from './client.js';

export interface RekeyContextValue {
  user: EndUserDto | null;
  signedIn: boolean;
  loading: boolean;
  client: RekeyBrowserClient;
  /** Manual refresh — re-fetch the current user. Useful after sign-in. */
  refresh: () => Promise<void>;
}

const Ctx = React.createContext<RekeyContextValue | null>(null);

export interface RekeyProviderProps {
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
  /**
   * Override the current-user endpoint. Defaults to `/api/v1/auth/me`, which
   * takes the user token alone (no Application key), so no proxy route is
   * needed. Set this only when you front Rekey with your own passthrough.
   */
  meEndpoint?: string;
}

export function RekeyProvider({
  children,
  apiUrl,
  publishableKey,
  initialUser = null,
  accessToken = null,
  meEndpoint,
}: RekeyProviderProps): React.JSX.Element {
  const client = React.useMemo(
    () =>
      new RekeyBrowserClient({
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

  const value: RekeyContextValue = React.useMemo(
    () => ({ user, signedIn: user !== null, loading, client, refresh }),
    [user, loading, client, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Internal — use the public hooks instead. */
export function useRekeyContext(): RekeyContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error(
      '@rekey.dev/react: hooks must be used inside <RekeyProvider>. Wrap your app at the root.',
    );
  }
  return ctx;
}
