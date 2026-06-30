'use client';

/**
 * Client-side provider boundary. Mounts @relipay/react's <RelipayProvider> so
 * client components can call useUser() / render <SignedIn> / <SignedOut>.
 *
 * The provider is seeded from the SERVER session (initialUser + accessToken)
 * resolved in the root layout — so there's no signed-out flash on first paint,
 * and the browser only ever holds the user's JWT (never the secret key).
 */

import * as React from 'react';
import { RelipayProvider } from '@relipay/react';
import type { EndUserDto } from '@relipay/react';

export function Providers({
  children,
  apiUrl,
  initialUser,
  accessToken,
}: {
  children: React.ReactNode;
  apiUrl: string;
  initialUser: EndUserDto | null;
  accessToken: string | null;
}): React.JSX.Element {
  return (
    <RelipayProvider apiUrl={apiUrl} initialUser={initialUser} accessToken={accessToken}>
      {children}
    </RelipayProvider>
  );
}
