'use client';

/**
 * Headless wrappers — render-prop style components.
 *
 * `<SignedIn>` renders children iff there's a user.
 * `<SignedOut>` renders children iff signed out.
 * `<Loading>` renders children while resolving.
 *
 * These are intentionally header-less — no opinions about your auth UI.
 * Your customer's app supplies the styled forms; we just give them the
 * "is the user signed in?" primitive.
 */

import * as React from 'react';
import { useUser } from './hooks.js';

export function SignedIn({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { signedIn, loading } = useUser();
  if (loading) return null;
  return signedIn ? <>{children}</> : null;
}

export function SignedOut({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { signedIn, loading } = useUser();
  if (loading) return null;
  return signedIn ? null : <>{children}</>;
}

export function Loading({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { loading } = useUser();
  return loading ? <>{children}</> : null;
}
