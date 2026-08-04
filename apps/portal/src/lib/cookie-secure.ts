/**
 * `Secure` for every cookie this app writes, decided from the live request.
 *
 * Was `process.env.NODE_ENV === 'production'` — a build-time answer to a
 * request-time question. A hosted portal behind TLS whose NODE_ENV was unset
 * (or `staging`, or anything Next did not inline as exactly `"production"`)
 * handed out end-user session cookies without `Secure`.
 *
 * See `cookieSecureFor` in @rekey.dev/shared-types for the decision itself and
 * why the fallback is fail-secure. `REKEY_COOKIE_SECURE=false` is the escape
 * hatch for an operator terminating TLS somewhere this code cannot observe.
 */

import { headers } from 'next/headers';
import { cookieSecureFor } from '@rekey.dev/shared-types';

export async function cookieSecure(): Promise<boolean> {
  try {
    const h = await headers();
    return cookieSecureFor({
      forwardedProto: h.get('x-forwarded-proto'),
      host: h.get('x-forwarded-host') ?? h.get('host'),
      override: process.env.REKEY_COOKIE_SECURE,
    });
  } catch {
    // `headers()` is unavailable outside a request scope. Nothing observable to
    // key off, so fall through to the fail-secure default rather than guessing.
    return cookieSecureFor({ override: process.env.REKEY_COOKIE_SECURE });
  }
}
