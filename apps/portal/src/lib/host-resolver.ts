/**
 * Which Application a custom domain serves, asked of the API and remembered
 * for a short while, so a page load does not cost an API call.
 *
 * Pure and runtime-neutral: the middleware runs it on the edge runtime.
 */

import { isPlainSlug } from './local-path';

export type HostAnswer = { kind: 'portal'; slug: string } | { kind: 'unknown' } | { kind: 'unavailable' };

const UNKNOWN: HostAnswer = { kind: 'unknown' };
const UNAVAILABLE: HostAnswer = { kind: 'unavailable' };

/** A domain that lapses or is removed stops being served within this. */
export const KNOWN_HOST_TTL_MS = 60_000;
/** A domain verified after a visit was turned away is served within this. */
export const UNKNOWN_HOST_TTL_MS = 60_000;
/** Per kind, so a flood of made-up hosts cannot push a real domain out. */
export const MAX_REMEMBERED_HOSTS = 1_000;
/**
 * API lookups for hosts not already known to serve a portal, per window. Every
 * made-up `Host` would otherwise be one API call, and the API counts these
 * calls against the portal's own address, which it never blocks. A real
 * domain's first lookup in a process counts too, and over the cap it is
 * answered 503 until the window passes.
 */
export const MAX_UNKNOWN_LOOKUPS = 30;
export const UNKNOWN_LOOKUP_WINDOW_MS = 10_000;

const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * `GET /api/v1/portal/config?host=<host>`: the Application serving `host`,
 * `unknown` on the API's 404, `unavailable` for anything else (no answer, a
 * 5xx, a 429, a body without a plain slug).
 */
export async function lookupPortalHost(apiUrl: string | undefined, host: string): Promise<HostAnswer> {
  if (!apiUrl) return UNAVAILABLE;
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v1/portal/config?host=${encodeURIComponent(host)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (res.status === 404) return UNKNOWN;
    if (!res.ok) return UNAVAILABLE;
    const body = (await res.json()) as { data?: { slug?: unknown } } | null;
    const slug = body?.data?.slug;
    return typeof slug === 'string' && isPlainSlug(slug) ? { kind: 'portal', slug } : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

interface Remembered {
  answer: HostAnswer;
  expiresAt: number;
}

function remember(map: Map<string, Remembered>, host: string, entry: Remembered): void {
  map.delete(host);
  if (map.size >= MAX_REMEMBERED_HOSTS) map.delete(map.keys().next().value!);
  map.set(host, entry);
}

/**
 * A resolver that remembers answers: a known host for {@link KNOWN_HOST_TTL_MS},
 * an unknown one for {@link UNKNOWN_HOST_TTL_MS}, nothing for `unavailable`.
 * Concurrent requests for one host share one lookup. Memory is per process.
 */
export function createHostResolver(
  lookup: (host: string) => Promise<HostAnswer>,
  { now = Date.now, maxUnknownLookups = MAX_UNKNOWN_LOOKUPS }: { now?: () => number; maxUnknownLookups?: number } = {},
): (host: string) => Promise<HostAnswer> {
  const known = new Map<string, Remembered>();
  const unknown = new Map<string, Remembered>();
  const inFlight = new Map<string, Promise<HostAnswer>>();
  let windowStart = -Infinity;
  let unknownLookups = 0;

  return (host) => {
    const at = now();
    const hit = known.get(host) ?? unknown.get(host);
    if (hit && hit.expiresAt > at) return Promise.resolve(hit.answer);
    const pending = inFlight.get(host);
    if (pending) return pending;

    if (!known.has(host)) {
      if (at - windowStart >= UNKNOWN_LOOKUP_WINDOW_MS) {
        windowStart = at;
        unknownLookups = 0;
      }
      if (unknownLookups >= maxUnknownLookups) return Promise.resolve(UNAVAILABLE);
      unknownLookups++;
    }

    const asked = lookup(host)
      .catch((): HostAnswer => UNAVAILABLE)
      .then((answer) => {
        const settledAt = now();
        if (answer.kind === 'portal') {
          unknown.delete(host);
          remember(known, host, { answer, expiresAt: settledAt + KNOWN_HOST_TTL_MS });
        } else if (answer.kind === 'unknown') {
          known.delete(host);
          remember(unknown, host, { answer, expiresAt: settledAt + UNKNOWN_HOST_TTL_MS });
        }
        return answer;
      });
    inFlight.set(host, asked);
    void asked.finally(() => inFlight.delete(host));
    return asked;
  };
}
