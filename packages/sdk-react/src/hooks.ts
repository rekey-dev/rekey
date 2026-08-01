/**
 * Public hooks. Idiomatic React with a familiar shape, so developers (and AI
 * agents) recognise them immediately.
 */

import type { EndUserDto } from '@rekey.dev/shared-types';
import { useRekeyContext } from './context.js';

/**
 * The current end-user, or `null` if signed out. Check `user` for null first,
 * then TypeScript narrows the type.
 *
 * @example
 * ```tsx
 * const { user, loading } = useUser();
 * if (loading) return <Spinner />;
 * // Narrow on `user`, not `signedIn` — the boolean is a sibling field and
 * // does not narrow the union for TypeScript.
 * if (!user) return <a href="/sign-in">Sign in</a>;
 * return <p>Hi {user.email}</p>;
 * ```
 */
export function useUser(): {
  user: EndUserDto | null;
  signedIn: boolean;
  loading: boolean;
} {
  const ctx = useRekeyContext();
  return { user: ctx.user, signedIn: ctx.signedIn, loading: ctx.loading };
}

/**
 * Manual session refresh. Usually called after a sign-in / sign-out
 * round-trip the customer's server handles, so the provider re-fetches
 * the latest user state.
 */
export function useRekey(): {
  refresh: () => Promise<void>;
} {
  const ctx = useRekeyContext();
  return { refresh: ctx.refresh };
}
