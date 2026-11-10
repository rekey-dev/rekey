/**
 * Sign-in with a social provider through the hosted portal.
 *
 * The portal asks the API for the provider's authorization URL, naming its own
 * `/<slug>/oauth/callback` page as the redirect URI. The provider sends the
 * browser back there with a one-time code, and the portal server spends the
 * code at the API's callback, which answers with the session in its response
 * body. No token is ever put in a URL. The `state` the provider round-trips is
 * checked against a cookie only the browser that started the sign-in holds.
 */

import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cache } from 'react';
import { cookies } from 'next/headers';
import type { OAuthProviderSummaryDto } from '@rekey.dev/shared-types';
import { getPortalConfig } from './config';
import { cookieSecure } from './cookie-secure';
import { rekeyApiUrl } from './env';
import { portalCustomHost, portalPublicBase } from './public-base';
import { API_TIMEOUT_MS, publishableKeyCallHeaders } from './client-ip';
import { portalClientFor } from './session';

export const SOCIAL_SIGN_IN = 'rekey_portal_social_sign_in';
/** Long enough to choose an account and approve at the provider. */
const SOCIAL_SIGN_IN_MAX_AGE = 10 * 60;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * The providers the operator offers in this portal, in the API's order; none
 * when the list cannot be read. Cached per request.
 */
export const socialSignInProviders = cache(async (slug: string): Promise<OAuthProviderSummaryDto[]> => {
  const client = await portalClientFor(slug);
  if (!client) return [];
  try {
    return (await client.listOAuthProviders()).providers.filter((p) => p.hostedPortal && PROVIDER_ID.test(p.id));
  } catch {
    return [];
  }
});

/** Where the provider sends the browser back, and the redirect URI the API is given for it. */
export async function socialSignInReturnUrl(slug: string): Promise<string> {
  return `${await portalPublicBase(slug)}/oauth/callback`;
}

async function cookieOptions(slug: string, maxAge: number) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: await cookieSecure(), path: (await portalCustomHost()) ? '/' : `/${slug}`, maxAge };
}

/** Start a sign-in in this browser: a fresh `state`, kept in a cookie with the provider it was started for. */
export async function beginSocialSignIn(slug: string, provider: string): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  (await cookies()).set(SOCIAL_SIGN_IN, `${provider}.${state}`, await cookieOptions(slug, SOCIAL_SIGN_IN_MAX_AGE));
  return state;
}

/**
 * The provider this browser started a sign-in with, when `state` is the one it
 * was given. Single-use: the cookie is cleared whatever the answer.
 */
export async function takeSocialSignIn(slug: string, state: string | null): Promise<{ provider: string } | null> {
  const jar = await cookies();
  const held = jar.get(SOCIAL_SIGN_IN)?.value ?? '';
  jar.set(SOCIAL_SIGN_IN, '', await cookieOptions(slug, 0));
  const dot = held.indexOf('.');
  if (dot < 1 || !state) return null;
  const provider = held.slice(0, dot);
  const expected = Buffer.from(held.slice(dot + 1));
  const given = Buffer.from(state);
  if (!PROVIDER_ID.test(provider) || expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { provider };
}

export type PublishableResult<T> = { ok: true; data: T } | { ok: false; code: string; retryAfterSeconds?: number };

/** A POST with the application's publishable key and the visitor headers, as the SDK client sends. */
export async function publishableKeyPost<T>(
  slug: string,
  path: string,
  body: Record<string, unknown>,
): Promise<PublishableResult<T>> {
  const config = await getPortalConfig(slug);
  if (!config) return { ok: false, code: 'PORTAL_NOT_FOUND' };
  let res: Response;
  try {
    res = await fetch(`${rekeyApiUrl()}${path}`, {
      method: 'POST',
      headers: {
        ...(await publishableKeyCallHeaders()),
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.publishableKey}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'NETWORK_ERROR' };
  }
  const json = (await res.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; retryAfterSeconds?: number } }
    | null;
  if (res.ok && json?.data !== undefined) return { ok: true, data: json.data };
  const retryAfterSeconds = json?.error?.retryAfterSeconds;
  return {
    ok: false,
    code: json?.error?.code ?? `HTTP_${res.status}`,
    ...(typeof retryAfterSeconds === 'number' && { retryAfterSeconds }),
  };
}
