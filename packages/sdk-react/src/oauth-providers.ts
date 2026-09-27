'use client';

import * as React from 'react';
import type { OAuthProviderSummaryDto } from '@rekey.dev/shared-types';
import { useOptionalRekeyContext } from './context.js';
import type { RekeyBrowserClient } from './client.js';

/**
 * One request per client for the life of the page. The client is memoised by
 * `<RekeyProvider>`, so a sign-in card that unmounts and mounts again (a modal,
 * a route change) renders its buttons on the first frame instead of refetching.
 */
const settled = new WeakMap<RekeyBrowserClient, OAuthProviderSummaryDto[]>();
const inflight = new WeakMap<RekeyBrowserClient, Promise<OAuthProviderSummaryDto[]>>();

function load(client: RekeyBrowserClient): Promise<OAuthProviderSummaryDto[]> {
  const pending = inflight.get(client);
  if (pending) return pending;
  const request = (async () => (await client.listOAuthProviders()).providers)().then(
    (providers) => {
      settled.set(client, providers);
      return providers;
    },
    (err: unknown) => {
      inflight.delete(client);
      throw err;
    },
  );
  inflight.set(client, request);
  return request;
}

/**
 * The OAuth providers the Application offers, fetched with the publishable key
 * from `<RekeyProvider>`. `null` until the list arrives, and stays `null` on
 * the server, outside a provider, or when the request fails, so a sign-in page
 * never breaks because of it.
 *
 * Fetched once per `<RekeyProvider>` and kept for the life of the page: a
 * provider enabled in the panel shows up after the next full page load, not
 * on a client-side navigation. A failed request is retried on the next mount.
 *
 * For buttons on the first paint, fetch the list on your server with
 * `rekey.auth.listOAuthProviders()` and pass it to `<SignIn oauthProviders>`
 * instead.
 *
 * @example
 * ```tsx
 * const providers = useOAuthProviders();
 * return providers?.map((p) => <a key={p.id} href={`/oauth/${p.id}`}>{p.name}</a>);
 * ```
 */
export function useOAuthProviders(options?: { enabled?: boolean }): OAuthProviderSummaryDto[] | null {
  const enabled = options?.enabled ?? true;
  const client = useOptionalRekeyContext()?.client ?? null;
  const [providers, setProviders] = React.useState<OAuthProviderSummaryDto[] | null>(() =>
    enabled && client ? (settled.get(client) ?? null) : null,
  );

  React.useEffect(() => {
    if (!enabled || !client) return;
    const cached = settled.get(client);
    if (cached) {
      setProviders(cached);
      return;
    }
    let live = true;
    load(client).then(
      (list) => {
        if (live) setProviders(list);
      },
      (err: unknown) => {
        console.warn('@rekey.dev/react: could not load OAuth providers, rendering none.', err);
      },
    );
    return () => {
      live = false;
    };
  }, [client, enabled]);

  return enabled ? providers : null;
}
