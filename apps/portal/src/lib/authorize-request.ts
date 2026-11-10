/**
 * The portal as an Application's authorization page: the API calls that
 * describe, grant and refuse a request `/oauth/authorize` stored, and the
 * cookie that carries the final redirect to the done page.
 *
 * The calls go from the portal server with the publishable key and the
 * deployment caller secret (`publishableKeyCallHeaders`). The API refuses a
 * publishable key without that secret, so a browser can never make them.
 */

import 'server-only';
import { cookies } from 'next/headers';
import type { PortalConfig } from './config';
import { rekeyApiUrl } from './env';
import { API_TIMEOUT_MS, publishableKeyCallHeaders } from './client-ip';
import { cookieSecure } from './cookie-secure';
import { portalCustomHost } from './public-base';
import { redirectWhenTwoFactorRequired } from './two-factor-redirect';

export interface AuthorizationPreview {
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  scope: string;
  account: { email: string };
  organizations: Array<{ id: string; name: string; role: string }>;
}

export type AuthorizeCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> };

/**
 * `preview` and `grant` act for the signed-in customer and send their token;
 * `deny` grants nothing and sends none.
 */
export async function authorizeCall<T>(
  config: PortalConfig,
  step: 'preview' | 'grant' | 'deny',
  body: Record<string, unknown>,
  accessToken?: string,
): Promise<AuthorizeCallResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${rekeyApiUrl()}/api/v1/mcp/${encodeURIComponent(config.slug)}/oauth/authorize/${step}`, {
      method: 'POST',
      headers: {
        ...(await publishableKeyCallHeaders()),
        Authorization: `Bearer ${config.publishableKey}`,
        ...(accessToken && { 'X-Rekey-User-Token': accessToken }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'NETWORK_ERROR' };
  }
  await redirectWhenTwoFactorRequired(config.slug, res);
  // These routes answer in the OAuth shape, not the `{ data }` envelope; their
  // refusals are the usual `{ error: { code } }`.
  const json = (await res.json().catch(() => null)) as
    | (T & { error?: { code?: string; details?: Record<string, unknown> } })
    | null;
  if (res.ok && json) return { ok: true, data: json };
  const details = json?.error?.details;
  return { ok: false, code: json?.error?.code ?? `HTTP_${res.status}`, ...(details && { details }) };
}

/** What a known scope lets the app do, in the words the consent screen uses. */
const SCOPE_WORDS: Record<string, string> = {
  openid: 'Know which account is yours',
  profile: 'See your name and profile picture',
  email: 'See your email address',
  'mcp:account': 'Read your account details, subscription, credits, devices and licences, without changing them',
};

/** Each scope with its plain description, or null for one this page has no words for. */
export function describeScopes(scope: string): Array<{ scope: string; words: string | null }> {
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => ({ scope: s, words: SCOPE_WORDS[s] ?? null }));
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where an answer sends the browser, named the way the customer can check it:
 * the host of a web address, scheme and host for an app's own scheme, and a
 * loopback address said to be this computer. `opensInPage` is true only for a
 * web address that is not on this computer.
 *
 * @example
 * redirectDestination('https://app.example/cb'); // { shown: 'app.example', kind: 'web', opensInPage: true }
 * redirectDestination('http://127.0.0.1:53682/cb'); // { shown: '127.0.0.1:53682', kind: 'this-computer', opensInPage: false }
 * redirectDestination('deskapp://callback'); // { shown: 'deskapp://callback', kind: 'app', opensInPage: false }
 */
export function redirectDestination(uri: string): { shown: string; kind: 'web' | 'this-computer' | 'app'; opensInPage: boolean } {
  const url = new URL(uri);
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    const local = LOOPBACK_HOSTS.has(url.hostname);
    return { shown: url.host, kind: local ? 'this-computer' : 'web', opensInPage: !local };
  }
  return { shown: url.host ? `${url.protocol}//${url.host}` : url.protocol, kind: 'app', opensInPage: false };
}

/** Never a navigation target here, whatever a cookie says. The API refuses them as redirect URIs too. */
// eslint-disable-next-line no-script-url -- named here because this list is what refuses it
const UNSAFE_TARGET = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);

/** The longest client name the screen shows in full. Apps pick their own names, up to 120 characters. */
const CLIENT_NAME_SHOWN = 60;

/**
 * @example
 * shownClientName('Desk'); // 'Desk'
 * shownClientName('x'.repeat(300)); // 'xxx…' (60 characters, then an ellipsis)
 */
export function shownClientName(name: string | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.length > CLIENT_NAME_SHOWN ? `${trimmed.slice(0, CLIENT_NAME_SHOWN)}…` : trimmed;
}

/** The API's refusal for a portal session on an Application that binds sign-in to a device. */
export const NEEDS_DEVICE_SESSION = 'AUTHORIZATION_NEEDS_DEVICE_SESSION';

export const AUTHORIZE_DONE = 'rekey_portal_authorize_done';
/** The authorization code inside the target lives 60 seconds. */
const AUTHORIZE_DONE_MAX_AGE = 60;

export interface AuthorizeDone {
  target: string;
  client: string | null;
  outcome: 'allowed' | 'cancelled';
}

async function doneCookieOpts(slug: string, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: await cookieSecure(),
    path: (await portalCustomHost()) ? '/' : `/${slug}`,
    maxAge,
  };
}

/** Server Actions only. Keeps the redirect out of every portal URL. */
export async function setAuthorizeDone(slug: string, done: AuthorizeDone): Promise<void> {
  (await cookies()).set(AUTHORIZE_DONE, JSON.stringify(done), await doneCookieOpts(slug, AUTHORIZE_DONE_MAX_AGE));
}

export async function getAuthorizeDone(): Promise<AuthorizeDone | null> {
  const raw = (await cookies()).get(AUTHORIZE_DONE)?.value;
  if (!raw) return null;
  try {
    const done = JSON.parse(raw) as Partial<AuthorizeDone>;
    if (typeof done.target !== 'string' || (done.outcome !== 'allowed' && done.outcome !== 'cancelled')) return null;
    if (UNSAFE_TARGET.has(new URL(done.target).protocol.toLowerCase())) return null;
    return { target: done.target, client: typeof done.client === 'string' ? done.client : null, outcome: done.outcome };
  } catch {
    return null;
  }
}

export async function clearAuthorizeDone(slug: string): Promise<void> {
  (await cookies()).set(AUTHORIZE_DONE, '', await doneCookieOpts(slug, 0));
}
