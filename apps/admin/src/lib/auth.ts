/**
 * Super-admin session store.
 *
 * The admin app holds the SUPER_ADMIN_KEY in its environment so it can call
 * the API. To avoid putting that literal secret in a browser cookie, we keep
 * an in-memory map of opaque session ids → expiry, and the cookie carries
 * only the opaque id. A leaked cookie buys an attacker N minutes of access
 * at most; it does NOT leak the key itself.
 *
 * In-memory is intentional:
 *   - Self-hosted, single-replica Dokploy deployment (see docker-compose.prod.yml).
 *   - One operator typically. Restart logs the operator out — acceptable cost.
 *   - Avoids a Redis dependency for the admin pod; the admin app stays standalone.
 *
 * If we ever scale the admin app to >1 replica, swap this for the shared Redis
 * the API already runs against (see apps/api/src/lib/redis.ts).
 */

import { timingSafeEqual, randomBytes } from 'node:crypto';
export { SESSION_COOKIE } from './cookies';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h sliding
const RATE_WINDOW_MS = 5 * 60 * 1000;       // 5-minute window
const RATE_LIMIT = 5;                        // 5 attempts/window/IP

interface Session {
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const failedAttempts = new Map<string, { count: number; resetAt: number }>();

/** Lazily resolve the env value so test setups can poke it. Refuse if absent. */
function adminKey(): Buffer {
  const k = process.env.SUPER_ADMIN_KEY ?? '';
  if (k.length < 32) {
    throw new Error(
      '[admin] SUPER_ADMIN_KEY missing or shorter than 32 chars. Set it on the admin container.',
    );
  }
  return Buffer.from(k, 'utf8');
}

/**
 * Constant-time compare of a presented key against `SUPER_ADMIN_KEY`. Returns
 * `true` only on exact match. Length is checked before `timingSafeEqual` (which
 * throws on mismatched lengths) — the length leak is not material.
 */
export function verifyKey(presented: string): boolean {
  const expected = adminKey();
  const actual = Buffer.from(presented, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Mint a new session and return its opaque id (64 hex chars = 32 bytes). */
export function createSession(): string {
  pruneExpired();
  const id = randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, { createdAt: now, expiresAt: now + SESSION_TTL_MS });
  return id;
}

/**
 * Look up a session id; refresh its sliding expiry on hit. Returns true iff
 * the session is known and not expired. Unknown / expired ids are evicted.
 */
export function validateSession(id: string | undefined | null): boolean {
  if (!id) return false;
  const s = sessions.get(id);
  if (!s) return false;
  const now = Date.now();
  if (s.expiresAt <= now) {
    sessions.delete(id);
    return false;
  }
  s.expiresAt = now + SESSION_TTL_MS;
  return true;
}

export function destroySession(id: string | undefined | null): void {
  if (id) sessions.delete(id);
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(id);
  }
  for (const [ip, b] of failedAttempts) {
    if (b.resetAt <= now) failedAttempts.delete(ip);
  }
}

/**
 * Per-IP login-rate bucket. Increments on every login attempt; the actual
 * rejection happens in the login route when this returns false. Window is
 * absolute, not sliding (simpler — and an attacker can't extend the window
 * by spamming further). Stores attempts by IP only; the IP comes from the
 * forwarded header chain enforced by the Next runtime.
 */
export function checkAndCountLoginAttempt(ip: string): { allowed: boolean; retryAfterSeconds: number } {
  pruneExpired();
  const now = Date.now();
  const bucket = failedAttempts.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    failedAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Drop the failure counter on a successful login so the operator isn't penalised. */
export function clearLoginRateLimit(ip: string): void {
  failedAttempts.delete(ip);
}

