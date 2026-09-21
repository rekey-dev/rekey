/**
 * Shared Redis client.
 *
 * One lazily-created ioredis connection for the whole process, reused by the
 * rate limiter and the verified-key memo (app.ts), the brute-force counters
 * (lib/brute-force.ts), the operator-auth, organization-role and dashboard
 * caches, the PKCE and assertion-replay stores, the prune sweep lease, and the
 * health and admin-metrics pings.
 *
 * Returns `null` under NODE_ENV=test, callers fall back to in-memory so the
 * suite needs no external Redis. In dev/prod it connects to `REDIS_URL`,
 * configured to fail FAST and never queue. Each consumer then picks its own
 * posture rather than inheriting one from here:
 *   - the global rate limiter fails OPEN (`app.ts`, `skipOnError: true`), an
 *     outage must not take the whole API down;
 *   - the auth tier fails CLOSED (`lib/rate-limit.ts`, `skipOnError: false`),
 *     an outage must not silently waive the caps on credential endpoints;
 *   - the outbound-webhook queue refuses to boot without Redis
 *     (`assertRedisReachable` in `modules/webhooks/webhook.queue.ts`).
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
  // Swallow connection errors here. Every consumer handles a rejected command
  // itself, each with the posture listed above (the brute-force counters and
  // the auth rate-limit tier fail CLOSED), so an unhandled 'error' event is the
  // only real risk.
  client.on('error', () => {
    /* intentionally ignored; each consumer handles its own command errors */
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
