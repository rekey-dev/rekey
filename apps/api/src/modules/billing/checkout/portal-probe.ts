/**
 * Readiness check 1: is the hosted portal deployed, reachable from the API,
 * able to reach the API back, and routing this Application's slug?
 *
 * The API mints a single-use nonce, calls `GET {portal}/{slug}/checkout/probe?n=`,
 * and the portal answers only after calling `GET /api/v1/checkout/probe/:nonce`
 * back. The probe passes only when both legs happened for this slug.
 *
 * The target is PUBLIC_PORTAL_URL, deployment configuration rather than
 * anything a tenant supplies, and the only tenant-derived part is the slug in
 * the path (charset-checked and encoded). Private addresses are allowed on
 * purpose, because a self-hosted portal on the same Docker network is the
 * normal case. Redirects are not followed, so the probe cannot be bounced to
 * another host, and nothing from the response body is reflected back.
 */

import { randomBytes } from 'node:crypto';
import { getRedis } from '../../../lib/redis.js';
import { portalBaseOrigin } from '../../../lib/portal-origins.js';

const NONCE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const SLOW_PROBE_MS = 2_000;
const KEY_PREFIX = 'checkout:probe:';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

type NonceState = { slug: string; confirmed: boolean };
const memory = new Map<string, NonceState & { expiresAt: number }>();

export interface ProbeResult {
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  fix: string | null;
  /** Whether the portal reported a working CSP report endpoint (check 8). */
  cspReports: boolean;
  at: string;
}

async function storeNonce(nonce: string, slug: string): Promise<void> {
  const redis = getRedis();
  const value: NonceState = { slug, confirmed: false };
  if (!redis) {
    memory.set(nonce, { ...value, expiresAt: Date.now() + NONCE_TTL_MS });
    return;
  }
  await redis.set(KEY_PREFIX + nonce, JSON.stringify(value), 'PX', NONCE_TTL_MS);
}

/**
 * The portal's callback. Marks the nonce seen exactly once and returns the
 * slug it was minted for; a second call, an unknown or an expired nonce
 * returns null.
 *
 * @example
 * await confirmProbeNonce(nonce); // 'acme' once, then null
 */
export async function confirmProbeNonce(nonce: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
  const redis = getRedis();
  if (!redis) {
    const hit = memory.get(nonce);
    if (!hit || hit.expiresAt <= Date.now() || hit.confirmed) return null;
    hit.confirmed = true;
    return hit.slug;
  }
  const raw = await redis.get(KEY_PREFIX + nonce);
  if (!raw) return null;
  const state = JSON.parse(raw) as NonceState;
  if (state.confirmed) return null;
  const confirmed: NonceState = { slug: state.slug, confirmed: true };
  // XX + GET: only an existing key is replaced, and the previous value tells
  // us whether a concurrent callback confirmed it first.
  const previous = await redis.set(KEY_PREFIX + nonce, JSON.stringify(confirmed), 'PX', NONCE_TTL_MS, 'XX', 'GET');
  if (!previous || (JSON.parse(previous) as NonceState).confirmed) return null;
  return state.slug;
}

async function takeNonce(nonce: string): Promise<NonceState | null> {
  const redis = getRedis();
  if (!redis) {
    const hit = memory.get(nonce);
    memory.delete(nonce);
    return hit && hit.expiresAt > Date.now() ? hit : null;
  }
  const raw = await redis.getdel(KEY_PREFIX + nonce);
  return raw ? (JSON.parse(raw) as NonceState) : null;
}

async function reportsCsp(response: Response): Promise<boolean> {
  const body = (await response.json().catch(() => null)) as { cspReports?: unknown } | null;
  return body?.cspReports === true;
}

function fail(message: string, fix: string): ProbeResult {
  return { status: 'FAIL', message, fix, cspReports: false, at: new Date().toISOString() };
}

/**
 * Run the probe for one Application slug.
 *
 * @example
 * const result = await probePortal('acme', 'https://api.example.com');
 * // { status: 'PASS', … } once the portal has called back
 */
export async function probePortal(slug: string, apiUrl: string): Promise<ProbeResult> {
  const portal = portalBaseOrigin();
  if (portal === null) {
    return fail(
      'This deployment runs no hosted portal, so there is nowhere to serve the checkout page.',
      'Set PUBLIC_PORTAL_URL on the API and deploy the portal service (`docker compose --profile full up`).',
    );
  }
  if (!SLUG_PATTERN.test(slug)) {
    return fail(
      `The slug "${slug}" cannot be served by the portal.`,
      'Use an Application slug of lowercase letters, digits and dashes.',
    );
  }
  const nonce = randomBytes(32).toString('base64url');
  await storeNonce(nonce, slug);
  const unreachable = fail(
    `The portal at ${portal} did not answer the checkout probe within ${PROBE_TIMEOUT_MS / 1000} s.`,
    `Check that the portal service is running and can reach the API at ${apiUrl}.`,
  );
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${portal}/${encodeURIComponent(slug)}/checkout/probe?n=${nonce}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch {
    await takeNonce(nonce);
    return unreachable;
  }
  const elapsed = Date.now() - started;
  const state = await takeNonce(nonce);
  if (!response.ok || state === null || !state.confirmed || state.slug !== slug) {
    return fail(
      `The portal at ${portal} answered the checkout probe for "${slug}" without confirming it with the API (HTTP ${response.status}).`,
      `Check that the portal service is running a version with the checkout page, and that it can reach the API at ${apiUrl}.`,
    );
  }
  const cspReports = await reportsCsp(response);
  const at = new Date().toISOString();
  if (elapsed > SLOW_PROBE_MS) {
    return {
      status: 'WARN',
      message: `The portal answered the checkout probe in ${elapsed} ms, which buyers will notice.`,
      fix: `Check the network path between the portal at ${portal} and the API at ${apiUrl}.`,
      cspReports,
      at,
    };
  }
  return { status: 'PASS', message: `The portal at ${portal} serves checkout pages for "${slug}".`, fix: null, cspReports, at };
}

/** Test seam: forget every nonce held in memory. */
export function __resetForTests(): void {
  memory.clear();
}
