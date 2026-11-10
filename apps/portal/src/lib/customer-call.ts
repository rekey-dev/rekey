/**
 * A call the signed-in customer makes for themselves: the publishable key
 * names the application, the access token the customer. A null token makes
 * the call with the publishable key alone, for a route that takes another
 * proof when nobody is signed in.
 */

import 'server-only';
import type { PortalConfig } from './config';
import { rekeyApiUrl } from './env';
import { API_TIMEOUT_MS, publishableKeyCallHeaders } from './client-ip';
import { redirectWhenTwoFactorRequired } from './two-factor-redirect';
import { redirectWhenProfileIncomplete } from './profile-redirect';

export type CustomerCallResult<T> = { ok: true; data: T } | { ok: false; code: string; retryAfterSeconds?: number };

export async function customerCall<T>(
  config: PortalConfig,
  accessToken: string | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<CustomerCallResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${rekeyApiUrl()}${path}`, {
      method,
      headers: {
        ...(await publishableKeyCallHeaders()),
        Authorization: `Bearer ${config.publishableKey}`,
        ...(accessToken !== null && { 'X-Rekey-User-Token': accessToken }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'NETWORK_ERROR' };
  }
  await redirectWhenTwoFactorRequired(config.slug, res);
  await redirectWhenProfileIncomplete(config.slug, res);
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
