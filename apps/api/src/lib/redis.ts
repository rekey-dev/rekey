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
 * configured to fail FAST and never queue: a command that gets no answer in
 * a second is rejected, which is what turns a stalled Redis into an error the
 * consumers below can act on. The BullMQ connections in `lib/queue.ts` are
 * separate and carry no such deadline, since their blocking commands must
 * wait. Each consumer then picks its own
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

const COMMAND_TIMEOUT_MS = 1000;
/** The message ioredis rejects with when `commandTimeout` passes. */
const COMMAND_TIMED_OUT = 'Command timed out';

let client: Redis | null = null;
let initialised = false;

export function getRedis(): Redis | null {
  if (env.NODE_ENV === 'test') return null;
  if (initialised) return client;
  initialised = true;
  if (!env.REDIS_URL) return null;
  client = createSharedRedis(env.REDIS_URL);
  return client;
}

/**
 * Build a client with the shared, fail-fast options. `getRedis` is the only
 * production caller; it is exported so a test can point one at a server of
 * its own.
 *
 * @example
 * const redis = createSharedRedis('redis://127.0.0.1:6379');
 */
export function createSharedRedis(url: string): Redis {
  const redis = new Redis(url, {
    connectTimeout: 500,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // Swallow connection errors here. Every consumer handles a rejected command
  // itself, each with the posture listed above (the brute-force counters and
  // the auth rate-limit tier fail CLOSED), so an unhandled 'error' event is the
  // only real risk.
  redis.on('error', () => {
    /* intentionally ignored; each consumer handles its own command errors */
  });
  dropConnectionOnCommandTimeout(redis);
  return redis;
}

/**
 * Security: a Redis that keeps its socket open and stops answering (a paused
 * container, a wedged host) rejects nothing, so without a deadline the auth
 * tier's fail-closed 503 never fires and every request hangs. `commandTimeout`
 * is that deadline.
 *
 * One request runs several commands in turn, and the fail-open ones would each
 * wait out the deadline before the next starts. So the first timeout also
 * drops the connection: the client goes back behind its ready check, which
 * refuses every later command at once until Redis answers again.
 */
function dropConnectionOnCommandTimeout(redis: Redis): void {
  const send = redis.sendCommand.bind(redis);
  // ioredis sends an unanswered command again after it reconnects. Watching
  // that second send would see the old timeout and drop the new connection.
  const watched = new WeakSet<object>();
  redis.sendCommand = (command, stream) => {
    const reply = send(command, stream);
    if (watched.has(command)) return reply;
    watched.add(command);
    command.promise.catch((err: unknown) => {
      if (err instanceof Error && err.message === COMMAND_TIMED_OUT && redis.status === 'ready') {
        redis.disconnect(true);
      }
    });
    return reply;
  };
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
    initialised = false;
  }
}
