import * as React from 'react';
import './globals.css';
import type { Metadata } from 'next';
import { getSession } from '@/lib/session';
import { RELIPAY_URL } from '@/lib/relipay';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'ReliPay SaaS — Next.js boilerplate',
  description:
    'A complete Next.js 15 SaaS starter wired to ReliPay: auth, org-scoped billing, credits, usage metering, entitlements & teams.',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  // Resolve the session on the server, then seed the browser provider with the
  // user + access token. Client components read auth state via useUser() /
  // <SignedIn> / <SignedOut> without ever touching the secret key.
  const session = await getSession();
  return (
    <html lang="en">
      <body className="min-h-screen text-neutral-900 dark:text-neutral-100 antialiased">
        <Providers
          apiUrl={RELIPAY_URL}
          initialUser={session?.user ?? null}
          accessToken={session?.accessToken ?? null}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
