/**
 * Cap on built-in auth email to one mailbox: per hour and per UTC day.
 *
 * Reset, sign-in-link and verification requests take an address from anyone
 * holding a publishable key, and the request limits count by caller address,
 * so a caller spread over many IPs could fill one inbox without limit. This
 * counts by RECIPIENT, whoever asks and from wherever. `scope` is the
 * Application id, or `operator` for panel mail.
 *
 * The allowance is for mail that goes out. A request that turns out to send
 * nothing (an unknown address, an account with nothing to verify, a banned
 * one) gives its reservation back, or five silent requests an hour would stop
 * all auth mail to an address whose inbox stayed empty. Those requests are
 * counted on their own, to the same limits, so a secret-key caller meets the
 * 429 after the same number of requests whether the address has an account
 * or not.
 *
 * Fails CLOSED: a Redis error answers 503 rather than sending uncapped. Under
 * test there is no Redis and an in-memory store backs the same logic; the cap
 * is only applied there when a test opts in, like every other limiter.
 */

import { createHash } from 'node:crypto';
import type { Application } from '@prisma/client';
import { env } from '../../config/env.js';
import { dependencyUnavailablePayload, RekeyError } from '../../lib/error.js';
import { rateLimitsEnforced } from '../../lib/rate-limit.js';
import { getRedis } from '../../lib/redis.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { recipientCapKey } from './custom/send-caps.js';

export interface AuthEmailScope {
  /** The Application id, or `operator`. */
  key: string;
  applicationId: string | null;
  tenantId: string | null;
}

export const OPERATOR_EMAIL_SCOPE: AuthEmailScope = { key: 'operator', applicationId: null, tenantId: null };

export function applicationEmailScope(application: Pick<Application, 'id' | 'tenantId'>): AuthEmailScope {
  return { key: application.id, applicationId: application.id, tenantId: application.tenantId };
}

export type AuthEmailRefusal = { allowed: false; retryAfterSeconds: number };

export type AuthEmailReservation =
  | {
      allowed: true;
      /**
       * Call when the request sent no mail after all. Gives the reservation
       * back and counts the request against the address's allowance of
       * requests that send nothing; the result says whether that one is
       * spent. Never throws.
       */
      unsent: () => Promise<{ allowed: true } | AuthEmailRefusal>;
    }
  | AuthEmailRefusal;

const memory = new Map<string, { value: number; expiresAt: number }>();

const INCR_WITH_TTL = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

async function incr(key: string, ttlSec: number): Promise<number> {
  const redis = getRedis();
  if (redis) return Number(await redis.eval(INCR_WITH_TTL, 1, key, String(ttlSec)));
  if (process.env.NODE_ENV === 'production') throw new Error('redis unavailable');
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.expiresAt <= now) {
    memory.set(key, { value: 1, expiresAt: now + ttlSec * 1000 });
    return 1;
  }
  entry.value += 1;
  return entry.value;
}

// Guarded, so giving back after the window's key expired does not leave a
// negative counter with no expiry behind.
const DECR_IF_PRESENT = `if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('DECR', KEYS[1]) end
return 0`;

async function decr(key: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.eval(DECR_IF_PRESENT, 1, key);
    return;
  }
  const entry = memory.get(key);
  if (entry && entry.expiresAt > Date.now() && entry.value > 0) entry.value -= 1;
}

export function __resetForTests(): void {
  memory.clear();
}

/**
 * Count one auth email to `to` against both windows, or refuse it.
 *
 * Call BEFORE looking the address up wherever the address comes from the
 * caller: a cap spent only by known addresses, or a Redis error raised only
 * for them, would say which addresses have accounts.
 *
 * @example
 *   const reserved = await reserveAuthEmail(applicationEmailScope(application), email);
 *   if (!reserved.allowed) throw authEmailCappedError(reserved.retryAfterSeconds);
 */
export async function reserveAuthEmail(
  scope: AuthEmailScope,
  to: string,
  now: Date = new Date(),
): Promise<AuthEmailReservation> {
  if (!rateLimitsEnforced()) return { allowed: true, unsent: async () => ({ allowed: true }) };
  const recipient = createHash('sha256').update(recipientCapKey(to)).digest('hex').slice(0, 32);
  const windows = capWindows(now);
  const keys = (kind: 'rcpt' | 'quiet'): { hour: string; day: string } => ({
    hour: `authmail:${kind}:${scope.key}:${recipient}:h:${windows.hour}`,
    day: `authmail:${kind}:${scope.key}:${recipient}:d:${windows.day}`,
  });
  try {
    const refused = await countAgainst(keys('rcpt'), windows);
    if (refused === null) {
      return {
        allowed: true,
        unsent: async () => {
          try {
            const sent = keys('rcpt');
            await decr(sent.hour);
            await decr(sent.day);
            const quiet = await countAgainst(keys('quiet'), windows);
            return quiet === null ? { allowed: true } : { allowed: false, retryAfterSeconds: quiet.retryAfterSeconds };
          } catch {
            return { allowed: true };
          }
        },
      };
    }
    const firstThisHour =
      (await incr(`authmail:noted:${scope.key}:${recipient}:${windows.hour}`, windows.secondsLeftInHour + 60)) === 1;
    if (firstThisHour) {
      // The recipient is a hash, never the address: an unknown address is a
      // string the caller chose, and it does not belong in an audit log.
      void recordSecurityEvent({
        type: 'auth.email_recipient_capped',
        actorType: 'system',
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        metadata: { recipientHash: recipient, window: refused.window, cap: refused.cap, scope: scope.key },
      });
    }
    return { allowed: false, retryAfterSeconds: refused.retryAfterSeconds };
  } catch (err) {
    if (err instanceof RekeyError) throw err;
    throw new RekeyError(dependencyUnavailablePayload('redis'));
  }
}

interface CapWindows {
  hour: string;
  day: string;
  secondsLeftInHour: number;
  secondsLeftInDay: number;
}

function capWindows(now: Date): CapWindows {
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  return {
    hour,
    day,
    secondsLeftInDay: Math.max(1, Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now.getTime()) / 1000)),
    secondsLeftInHour: Math.max(1, Math.ceil((Date.parse(`${hour}:00:00Z`) + 3_600_000 - now.getTime()) / 1000)),
  };
}

/** Count one against an hour and a day counter. Null when both had room. */
async function countAgainst(
  keys: { hour: string; day: string },
  windows: CapWindows,
): Promise<{ window: 'hour' | 'day'; cap: number; retryAfterSeconds: number } | null> {
  if ((await incr(keys.hour, windows.secondsLeftInHour + 60)) > env.AUTH_EMAIL_RECIPIENT_HOURLY_CAP) {
    return { window: 'hour', cap: env.AUTH_EMAIL_RECIPIENT_HOURLY_CAP, retryAfterSeconds: windows.secondsLeftInHour };
  }
  if ((await incr(keys.day, windows.secondsLeftInDay + 60)) > env.AUTH_EMAIL_RECIPIENT_DAILY_CAP) {
    // Refused, so it must not use up the hourly allowance either.
    await decr(keys.hour);
    return { window: 'day', cap: env.AUTH_EMAIL_RECIPIENT_DAILY_CAP, retryAfterSeconds: windows.secondsLeftInDay };
  }
  return null;
}

/**
 * `reserveAuthEmail` for mail nobody asked for by address (the welcome, the
 * sign-up verification, an invitation): over the cap, or with the counter
 * unreachable, the mail is skipped and whatever created it still succeeds.
 *
 * @example
 *   if (!(await mayMailUnattended(applicationEmailScope(application), user.email))) return;
 */
export async function mayMailUnattended(scope: AuthEmailScope, to: string): Promise<boolean> {
  try {
    return (await reserveAuthEmail(scope, to)).allowed;
  } catch {
    return false;
  }
}

/** The refusal a secret-key caller gets. A publishable caller gets the route's constant body instead. */
export function authEmailCappedError(retryAfterSeconds: number): RekeyError {
  return new RekeyError({
    statusCode: 429,
    code: 'AUTH_EMAIL_RECIPIENT_CAPPED',
    message: 'This address has been sent the maximum number of sign-in emails for now. Nothing was sent.',
    fix: 'Wait for the number of seconds in Retry-After (also `error.retryAfterSeconds`) before asking for another email to this address. The links already in that inbox still work until they expire. The limits are AUTH_EMAIL_RECIPIENT_HOURLY_CAP and AUTH_EMAIL_RECIPIENT_DAILY_CAP on the deployment.',
    retryAfterSeconds,
  });
}
