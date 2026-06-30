/**
 * HIBP Pwned Passwords k-anonymity check.
 *
 * We never send the raw password (or even a full hash) to HIBP. The
 * protocol is:
 *
 *   1. SHA-1 the password — yes SHA-1, that's the wire format HIBP uses.
 *   2. GET https://api.pwnedpasswords.com/range/<first 5 hex chars>
 *   3. Response is a `\r\n`-delimited list of `SUFFIX:COUNT` rows.
 *   4. If the remaining 35 chars of our hash appear in the list, the
 *      password has been seen `COUNT` times across known breaches.
 *
 * We treat any non-zero match as "breached". This is conservative — HIBP
 * surfaces counts as low as 1, and the value of breach-checking is the
 * categorical signal, not the magnitude.
 *
 * **SHA-1 is fine here.** We are using it as a lookup key against a
 * public dataset, not as a credential hash. Argon2id is still doing the
 * actual password storage in `lib/passwords.ts`.
 *
 * Failure mode: when HIBP is unreachable or slow we let the password
 * through. Breach-checking is defence-in-depth, not the security
 * primitive — refusing sign-up because the breach API is down would be
 * worse for users than letting one weak password through. The check has
 * a 1.5-second timeout and any error returns `{ breached: false }`.
 */

import { createHash } from 'node:crypto';

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const REQUEST_TIMEOUT_MS = 1500;

export interface BreachCheckResult {
  breached: boolean;
  /** When breached: count from HIBP. Otherwise 0. */
  count: number;
  /** True iff HIBP responded; false on timeout/network error. */
  contacted: boolean;
}

function sha1Upper(s: string): string {
  return createHash('sha1').update(s).digest('hex').toUpperCase();
}

export async function checkPasswordBreached(
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BreachCheckResult> {
  // Empty password is never queried — caller will fail the min-length
  // check first anyway. Defensive guard.
  if (password.length === 0) return { breached: false, count: 0, contacted: false };

  const fullHash = sha1Upper(password);
  const prefix = fullHash.slice(0, 5);
  const suffix = fullHash.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${HIBP_RANGE_URL}${prefix}`, {
      headers: {
        // HIBP requires this header to be present, otherwise responds 400.
        'Add-Padding': 'true',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 4xx/5xx — treat as unreachable to avoid blocking sign-up.
      return { breached: false, count: 0, contacted: false };
    }
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const [rowSuffix, rowCountStr] = line.split(':');
      if (!rowSuffix) continue;
      if (rowSuffix.trim().toUpperCase() === suffix) {
        const count = Number.parseInt((rowCountStr ?? '0').trim(), 10);
        return {
          breached: Number.isFinite(count) && count > 0,
          count: Number.isFinite(count) ? count : 0,
          contacted: true,
        };
      }
    }
    return { breached: false, count: 0, contacted: true };
  } catch {
    return { breached: false, count: 0, contacted: false };
  } finally {
    clearTimeout(timer);
  }
}
