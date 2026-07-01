/**
 * Server-side session resolver.
 *
 * Reads the access cookie and resolves the current user. If the token has
 * expired, redirects to `/refresh-session` (a Route Handler) which performs
 * the refresh + cookie rotation and bounces back to `?return=<path>`.
 *
 * Why a Route Handler: Next 15 forbids cookie writes from server components.
 * Only Server Actions and Route Handlers can mutate the cookie jar. This
 * helper stays read-only and delegates the writes.
 */

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { RelipayError, getAccessToken, relipay } from './relipay';
import type { EndUserDto } from '@relipay/node';

async function currentPath(): Promise<string> {
  const h = await headers();
  return h.get('x-invoke-path') ?? h.get('next-url') ?? '/';
}

export async function requireUser(): Promise<EndUserDto> {
  const access = await getAccessToken();
  if (!access) redirect('/sign-in');

  try {
    return await relipay.auth.getCurrentUser(access);
  } catch (err) {
    if (err instanceof RelipayError && err.code === 'USER_TOKEN_INVALID') {
      const ret = await currentPath();
      redirect(`/refresh-session?return=${encodeURIComponent(ret)}`);
    }
    throw err;
  }
}
