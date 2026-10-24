'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { publicPost, PanelApiError } from '@/lib/api';
import { cookieSecure } from '@/lib/cookie-secure';
import { safeNext } from '@/lib/safe-next';
import { loginErrorCode } from './error-messages';

/**
 * Begin an operator OAuth sign-in. Stash a one-shot CSRF `state` in an httpOnly
 * cookie, then redirect the browser to the provider. The callback route
 * (/login/oauth/[provider]/callback) verifies the cookie against the returned
 * `state` before exchanging the code.
 *
 * `_formData` is the Next bound-action arg (ignored, provider is bound).
 */
export async function startOAuth(provider: string, next: string | null, _formData: FormData): Promise<void> {
  const state = randomUUID();
  const jar = await cookies();
  const secure = await cookieSecure();
  // `lax`, not `strict`: the provider redirects back via a top-level cross-site
  // GET on which a Strict cookie is NOT sent, which would break the CSRF check.
  const opts = { httpOnly: true as const, sameSite: 'lax' as const, secure, path: '/', maxAge: 600 };
  jar.set('oauth_state', state, opts);
  jar.set('oauth_provider', provider, opts);
  // Carry `next` across the provider round-trip in a one-shot cookie (OAuth
  // `state` stays a pure CSRF nonce). Validated here AND re-validated by the
  // callback route before following.
  const safe = safeNext(next);
  if (safe) jar.set('oauth_next', safe, opts);
  else jar.delete('oauth_next');
  let authorizationUrl: string;
  try {
    const data = await publicPost<{ authorizationUrl: string }>(
      `/api/v1/tenant/auth/oauth/${encodeURIComponent(provider)}/start`,
      { state },
    );
    authorizationUrl = data.authorizationUrl;
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(
        `/login?error=${loginErrorCode(err.code)}${safe ? `&next=${encodeURIComponent(safe)}` : ''}`,
      );
    }
    throw err;
  }
  redirect(authorizationUrl);
}
