/**
 * The invitation token inside a post-sign-in destination, when that
 * destination is the accept-invite page. Sign-in by a provider hands it to the
 * API as the invite key, so someone with no operator account yet is created
 * straight into the workspace that invited them instead of being refused by
 * invite-only registration.
 *
 * @example
 * invitationTokenIn('/accept-invite?token=abc') // 'abc'
 * invitationTokenIn('/applications') // null
 */
export function invitationTokenIn(next: string | null): string | null {
  if (!next) return null;
  const url = new URL(next, 'https://next.invalid');
  if (url.pathname !== '/accept-invite') return null;
  return url.searchParams.get('token')?.trim() || null;
}
