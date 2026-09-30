/**
 * Rate limits on subscribes that come from a browser: a publishable key, or a
 * secret key that names the visitor with `X-Rekey-Client-Ip`. A server
 * subscribing on its own behalf (secret key, no visitor) gets only a wide
 * per-list ceiling, so a backfill runs but a relay that forgot the visitor
 * address cannot flood a list either.
 *
 * Fixed windows in Redis, failing CLOSED with 503 like the email send caps:
 * these are what stands between a public form and a flood of junk addresses.
 * Under test there is no Redis and an in-memory store backs the same logic.
 */

import { dependencyUnavailablePayload, RekeyError } from '../../lib/error.js';
import { getRedis } from '../../lib/redis.js';
import { contactsRateLimited } from './errors.js';

export const CAPTURE_PER_VISITOR_MINUTE = 5;
export const CAPTURE_PER_VISITOR_HOUR = 30;
export const CAPTURE_PER_LIST_MINUTE = 120;
export const SERVER_PER_LIST_MINUTE = 1200;

const memory = new Map<string, { value: number; expiresAt: number }>();

const INCR_WITH_TTL = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

async function incr(key: string, ttlSec: number): Promise<number> {
  const redis = getRedis();
  if (!redis) {
    if (process.env.NODE_ENV === 'production') throw new RekeyError(dependencyUnavailablePayload('redis'));
    const now = Date.now();
    const entry = memory.get(key);
    if (!entry || entry.expiresAt <= now) {
      memory.set(key, { value: 1, expiresAt: now + ttlSec * 1000 });
      return 1;
    }
    entry.value += 1;
    return entry.value;
  }
  return Number(await redis.eval(INCR_WITH_TTL, 1, key, String(ttlSec)));
}

/** Count one subscribe from a server speaking for itself against its per-list ceiling. */
export async function consumeServerAllowance(listId: string, now = Date.now()): Promise<void> {
  const minute = Math.floor(now / 60_000);
  try {
    if ((await incr(`contacts:cap:server:${listId}:m:${minute}`, 120)) > SERVER_PER_LIST_MINUTE) {
      throw contactsRateLimited(
        `This list has taken ${SERVER_PER_LIST_MINUTE} server subscribes in the last minute.`,
        secondsLeft(60_000, now),
      );
    }
  } catch (err) {
    if (err instanceof RekeyError) throw err;
    throw new RekeyError(dependencyUnavailablePayload('redis'));
  }
}

/** True the first time in a UTC hour a workspace's quota refusal is noted. Best effort. */
export async function markQuotaEventDue(tenantId: string, now = Date.now()): Promise<boolean> {
  try {
    return (await incr(`contacts:quota-notice:${tenantId}:${Math.floor(now / 3_600_000)}`, 3_700)) === 1;
  } catch {
    return false;
  }
}

export function __resetForTests(): void {
  memory.clear();
}

function secondsLeft(windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
}

export interface CaptureCaller {
  tenantId: string;
  applicationId: string;
  listId: string;
  /** The visitor's address, or null when it cannot be attributed to one person. */
  visitorIp: string | null;
  dailyCap: number | null | undefined;
}

/**
 * Count one browser subscribe against every bucket that applies, or refuse
 * it with `CONTACTS_RATE_LIMITED`. Order is cheapest-to-exhaust first, so one
 * noisy visitor is refused before they spend the list's shared allowance.
 */
export async function consumeCaptureAllowance(caller: CaptureCaller, now = Date.now()): Promise<void> {
  const minute = Math.floor(now / 60_000);
  const hour = Math.floor(now / 3_600_000);
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    if (caller.visitorIp) {
      const visitor = `contacts:cap:ip:${caller.applicationId}:${caller.visitorIp}`;
      if ((await incr(`${visitor}:m:${minute}`, 120)) > CAPTURE_PER_VISITOR_MINUTE) {
        throw contactsRateLimited(
          `This address has subscribed ${CAPTURE_PER_VISITOR_MINUTE} times in the last minute.`,
          secondsLeft(60_000, now),
        );
      }
      if ((await incr(`${visitor}:h:${hour}`, 3_700)) > CAPTURE_PER_VISITOR_HOUR) {
        throw contactsRateLimited(
          `This address has subscribed ${CAPTURE_PER_VISITOR_HOUR} times in the last hour.`,
          secondsLeft(3_600_000, now),
        );
      }
    }
    if ((await incr(`contacts:cap:list:${caller.listId}:m:${minute}`, 120)) > CAPTURE_PER_LIST_MINUTE) {
      throw contactsRateLimited(
        `This list has taken ${CAPTURE_PER_LIST_MINUTE} subscribes in the last minute.`,
        secondsLeft(60_000, now),
      );
    }
    if (caller.dailyCap !== null && caller.dailyCap !== undefined) {
      if ((await incr(`contacts:cap:day:${caller.tenantId}:${day}`, 90_000)) > caller.dailyCap) {
        throw contactsRateLimited(
          `This workspace has taken its limit of ${caller.dailyCap} browser subscribes for this UTC day.`,
          secondsLeft(86_400_000, now),
        );
      }
    }
  } catch (err) {
    if (err instanceof RekeyError) throw err;
    throw new RekeyError(dependencyUnavailablePayload('redis'));
  }
}
