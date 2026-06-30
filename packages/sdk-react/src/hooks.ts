/**
 * Public hooks. Idiomatic React with a familiar shape, so developers (and AI
 * agents) recognise them immediately.
 */

import type { EndUserDto } from '@relipay/shared-types';
import { useRelipayContext } from './context.js';

/**
 * The current end-user, or `null` if signed out. Check `user` for null first,
 * then TypeScript narrows the type.
 *
 * @example
 * ```tsx
 * const { user, signedIn, loading } = useUser();
 * if (loading) return <Spinner />;
 * if (!signedIn) return <SignedOut />;
 * return <p>Hi {user.email}</p>;
 * ```
 */
export function useUser(): {
  user: EndUserDto | null;
  signedIn: boolean;
  loading: boolean;
} {
  const ctx = useRelipayContext();
  return { user: ctx.user, signedIn: ctx.signedIn, loading: ctx.loading };
}

/**
 * Manual session refresh. Usually called after a sign-in / sign-out
 * round-trip the customer's server handles, so the provider re-fetches
 * the latest user state.
 */
export function useRelipay(): {
  refresh: () => Promise<void>;
} {
  const ctx = useRelipayContext();
  return { refresh: ctx.refresh };
}
