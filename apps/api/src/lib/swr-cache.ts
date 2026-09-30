/**
 * Stale-while-revalidate cache with single-flight, for dashboard aggregates.
 *
 * Why not plain TTL: every expiry of a popular key used to send every waiting
 * reader to Postgres at once. Here only one caller per key computes:
 *
 *   - fresh hit: served.
 *   - stale hit: served at once, and ONE background refresh starts for the
 *     caller that wins `SET <lock> NX`.
 *   - miss: the caller that wins the lock computes; the others poll the key
 *     for up to `waitMs` and then get `pending` rather than computing too.
 *
 * Versioning works like `dashboard-cache.ts`: an entry carries the version it
 * was computed under and a read only accepts the current version, so a bump
 * (`bumpCacheVersion`) invalidates every entry under that version key at once,
 * including a computation already in flight.
 *
 * Redis absent (NODE_ENV=test) or failing: compute directly. The caller's own
 * semaphore still bounds the load.
 */

import { randomBytes } from 'node:crypto';
import { dashboardRedis } from './dashboard-cache.js';

export interface SwrOptions {
  freshSeconds: number;
  /** How long past fresh an entry may still be served while it refreshes. */
  staleSeconds: number;
  /** Bump this key to invalidate. Defaults to `<key>:v`. */
  versionKey?: string;
  waitMs?: number;
  pollMs?: number;
  lockMs?: number;
  onBackgroundError?: (err: unknown) => void;
}

export interface CacheInfo {
  hit: boolean;
  stale: boolean;
  ageSeconds: number;
}

export type SwrResult<T> =
  | { status: 'ok'; value: T; computedAt: string; cache: CacheInfo }
  | { status: 'pending'; retryAfterSeconds: number };

interface Entry<T> {
  v: string;
  computedAt: number;
  freshUntil: number;
  value: T;
}

const DEFAULT_WAIT_MS = 2_500;
const DEFAULT_POLL_MS = 100;
const DEFAULT_LOCK_MS = 30_000;
const PENDING_RETRY_SECONDS = 3;
/** Longer than any entry lives, so an expired version cannot resurrect one. */
const VERSION_TTL_SECONDS = 24 * 60 * 60;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

function lockKeyFor(key: string): string {
  return `${key}:lock`;
}

function parse<T>(raw: string | null | undefined): Entry<T> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Entry<T>;
  } catch {
    return null;
  }
}

function okResult<T>(entry: Entry<T>, hit: boolean, now: number): SwrResult<T> {
  return {
    status: 'ok',
    value: entry.value,
    computedAt: new Date(entry.computedAt).toISOString(),
    cache: {
      hit,
      stale: hit && now >= entry.freshUntil,
      ageSeconds: hit ? Math.max(0, Math.floor((now - entry.computedAt) / 1000)) : 0,
    },
  };
}

function uncached<T>(value: T): SwrResult<T> {
  const now = Date.now();
  return okResult({ v: '', computedAt: now, freshUntil: now, value }, false, now);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * @example
 *   const r = await cachedSwr('rk:an:users:v1:app_1:kpis:ab12', { freshSeconds: 60, staleSeconds: 900 }, compute);
 *   if (r.status === 'pending') return { status: 'pending', retryAfterSeconds: r.retryAfterSeconds };
 */
export async function cachedSwr<T>(
  key: string,
  options: SwrOptions,
  compute: () => Promise<T>,
): Promise<SwrResult<T>> {
  const redis = dashboardRedis();
  if (!redis) return uncached(await compute());
  const versionKey = options.versionKey ?? `${key}:v`;
  const lockKey = lockKeyFor(key);
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS;

  const read = async (): Promise<{ entry: Entry<T> | null; version: string }> => {
    const [raw, v] = await redis.mget(key, versionKey);
    const version = v ?? '0';
    const entry = parse<T>(raw);
    return { entry: entry && entry.v === version ? entry : null, version };
  };

  const store = async (version: string, value: T): Promise<Entry<T>> => {
    const now = Date.now();
    const entry: Entry<T> = { v: version, computedAt: now, freshUntil: now + options.freshSeconds * 1000, value };
    await redis
      .set(key, JSON.stringify(entry), 'EX', options.freshSeconds + options.staleSeconds)
      .catch(() => undefined);
    return entry;
  };

  const release = (token: string): Promise<unknown> =>
    redis.eval(RELEASE_SCRIPT, 1, lockKey, token).catch(() => undefined);

  let first: { entry: Entry<T> | null; version: string };
  try {
    first = await read();
  } catch {
    return uncached(await compute());
  }

  const now = Date.now();
  if (first.entry) {
    if (now >= first.entry.freshUntil) {
      void refreshInBackground();
    }
    return okResult(first.entry, true, now);
  }

  const token = randomBytes(12).toString('hex');
  let won: string | null;
  try {
    won = await redis.set(lockKey, token, 'PX', lockMs, 'NX');
  } catch {
    return uncached(await compute());
  }
  if (won === 'OK') {
    try {
      const entry = await store(first.version, await compute());
      return okResult(entry, false, Date.now());
    } finally {
      await release(token);
    }
  }

  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const again = await read();
      if (again.entry) return okResult(again.entry, true, Date.now());
    } catch {
      return uncached(await compute());
    }
  }
  return { status: 'pending', retryAfterSeconds: PENDING_RETRY_SECONDS };

  async function refreshInBackground(): Promise<void> {
    if (!redis) return;
    const refreshToken = randomBytes(12).toString('hex');
    try {
      const got = await redis.set(lockKey, refreshToken, 'PX', lockMs, 'NX');
      if (got !== 'OK') return;
    } catch {
      return;
    }
    try {
      await store(first.version, await compute());
    } catch (err) {
      options.onBackgroundError?.(err);
    } finally {
      await release(refreshToken);
    }
  }
}

/**
 * Invalidate every entry cached under `versionKey`.
 *
 * @example
 *   bumpCacheVersion(analyticsVersionKey(applicationId));
 */
export function bumpCacheVersion(versionKey: string): void {
  const redis = dashboardRedis();
  if (!redis) return;
  void redis
    .multi()
    .incr(versionKey)
    .expire(versionKey, VERSION_TTL_SECONDS)
    .exec()
    .catch(() => undefined);
}
