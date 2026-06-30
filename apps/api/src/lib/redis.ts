/**
 * Shared Redis client.
 *
 * One lazily-created ioredis connection for the whole process, reused by the
 * rate limiter (app.ts) and the brute-force counters (lib/brute-force.ts).
 *
 * Returns `null` under NODE_ENV=test — callers fall back to in-memory so the
 * suite needs no external Redis. In dev/prod it connects to `REDIS_URL`,
 * configured to fail FAST and never queue: every caller treats a Redis error
 * as "skip" (fail-open), so a Redis outage degrades brute-force protection to
 * off rather than taking auth down.
 */

import { Redis } from 'ioredis';
import { env } from '../config/env.js';

let client: Redis | null = null;
let initialised = false;

export function getRedis(): Redis | null {
  if (env.NODE_ENV === 'test') return null;
  if (initialised) return client;
  initialised = true;
  if (!env.REDIS_URL) return null;
  client = new Redis(env.REDIS_URL, {
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // Swallow connection errors here — every consumer is written to fail open on
  // a rejected command, so an unhandled 'error' event is the only real risk.
  client.on('error', () => {
    /* intentionally ignored; consumers fail open */
  });
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
    initialised = false;
  }
}
