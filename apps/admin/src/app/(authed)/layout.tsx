import * as React from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/cookies';
import { validateSession } from '@/lib/auth';
import { Sidebar } from '@/components/Sidebar';

/**
 * Authed shell. The Edge middleware only checks that *some* cookie is present;
 * the real session lookup happens here (Node runtime) and bounces an unknown
 * or expired session to /login. `validateSession()` also refreshes the sliding
 * expiry on every page render.
 */
export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!validateSession(id)) {
    // Clear the stale cookie and bounce. We can't write cookies from a server
    // component, so we lean on /sign-out (which is a Route Handler) to do it.
    redirect('/sign-out');
  }

  return (
    <div className="min-h-screen flex bg-[var(--color-bg)]">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-x-hidden">
        {/* pt-16 on mobile clears the fixed hamburger toggle (Sidebar.tsx). */}
        <div className="mx-auto max-w-7xl px-6 py-6 pt-16 md:pt-6 space-y-6">{children}</div>
      </main>
    </div>
  );
}
