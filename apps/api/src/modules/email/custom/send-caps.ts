/**
 * Caps on custom template sends: per workspace per UTC day, and per recipient
 * per workspace per hour. Fixed windows in Redis.
 *
 * Counted per workspace, not per Application, so a workspace cannot multiply
 * its allowance by creating Applications. `Tenant.limits` overrides the env
 * defaults for one workspace.
 *
 * Fails CLOSED. A Redis error answers 503 rather than sending uncapped: these
 * caps are the backstop for a leaked `email:send` key, and one that vanishes
 * during an outage protects nothing. Under test there is no Redis and an
 * in-memory store backs the same logic.
 */

import { createHash } from 'node:crypto';
import { env } from '../../../config/env.js';
import { dependencyUnavailablePayload, RekeyError } from '../../../lib/error.js';
import { getRedis } from '../../../lib/redis.js';
import { prisma } from '../../../lib/prisma.js';
import { parseTenantLimits } from '../../../lib/tenant-limits.js';

export interface SendCaps {
  daily: number;
  recipientHourly: number;
}

export function defaultCaps(): SendCaps {
  return { daily: env.EMAIL_SEND_DAILY_CAP, recipientHourly: env.EMAIL_SEND_RECIPIENT_HOURLY_CAP };
}

/** The caps in force for a workspace: its `Tenant.limits`, else the env defaults. */
export async function capsForTenant(tenantId: string): Promise<SendCaps> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { limits: true } });
  const limits = parseTenantLimits(tenant?.limits);
  const defaults = defaultCaps();
  return {
    daily: limits.emailSendDailyCap ?? defaults.daily,
    recipientHourly: limits.emailSendRecipientHourlyCap ?? defaults.recipientHourly,
  };
}

/**
 * The address a per-recipient allowance is counted under: lowercased, with a
 * `+tag` dropped from the local part, so `a+1@x` and `a+2@x` share one.
 */
export function recipientCapKey(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  const local = lower.slice(0, at);
  const plus = local.indexOf('+');
  return `${plus > 0 ? local.slice(0, plus) : local}${lower.slice(at)}`;
}

interface Counter {
  incr(key: string, ttlSec: number): Promise<number>;
  decr(key: string): Promise<void>;
}

const memory = new Map<string, { value: number; expiresAt: number }>();

const memoryCounter: Counter = {
  async incr(key, ttlSec) {
    const now = Date.now();
    const entry = memory.get(key);
    if (!entry || entry.expiresAt <= now) {
      memory.set(key, { value: 1, expiresAt: now + ttlSec * 1000 });
      return 1;
    }
    entry.value += 1;
    return entry.value;
  },
  async decr(key) {
    const entry = memory.get(key);
    if (entry) entry.value -= 1;
  },
};

/**
 * INCR and EXPIRE in one step. Two commands leave a window where a crash or a
 * dropped connection keeps a counter with no expiry, which would hold a
 * workspace at its cap forever.
 */
const INCR_WITH_TTL = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

function counter(): Counter {
  const redis = getRedis();
  if (!redis) {
    if (process.env.NODE_ENV === 'production') {
      throw new RekeyError(dependencyUnavailablePayload('redis'));
    }
    return memoryCounter;
  }
  return {
    async incr(key, ttlSec) {
      return Number(await redis.eval(INCR_WITH_TTL, 1, key, String(ttlSec)));
    },
    async decr(key) {
      await redis.decr(key);
    },
  };
}

export function __resetForTests(): void {
  memory.clear();
}

function rateLimited(message: string, retryAfterSeconds: number): RekeyError {
  return new RekeyError({
    statusCode: 429,
    code: 'EMAIL_RATE_LIMITED',
    message,
    fix: 'Wait for the number of seconds in Retry-After (also `error.retryAfterSeconds`) before sending again. Nothing was sent, so the same idempotency key can be reused.',
    retryAfterSeconds,
  });
}

/**
 * Count one send against both caps, or refuse it. Call only for a send that
 * will reach the transport: replays and suppressed sends are not counted.
 */
export async function consumeSendAllowance(
  tenantId: string,
  to: string,
  caps?: SendCaps,
  now: Date = new Date(),
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  const secondsLeftInDay = Math.max(1, Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now.getTime()) / 1000));
  const secondsLeftInHour = Math.max(1, Math.ceil((Date.parse(`${hour}:00:00Z`) + 3_600_000 - now.getTime()) / 1000));
  const recipient = createHash('sha256').update(recipientCapKey(to)).digest('hex').slice(0, 32);
  const dayKey = `email:cap:day:${tenantId}:${day}`;
  const recipientKey = `email:cap:rcpt:${tenantId}:${recipient}:${hour}`;

  const limits = caps ?? (await capsForTenant(tenantId));
  try {
    const store = counter();
    const sentToday = await store.incr(dayKey, secondsLeftInDay + 60);
    if (sentToday > limits.daily) {
      throw rateLimited(
        `This workspace has reached its limit of ${limits.daily} custom emails per UTC day.`,
        secondsLeftInDay,
      );
    }
    const sentToRecipient = await store.incr(recipientKey, secondsLeftInHour + 60);
    if (sentToRecipient > limits.recipientHourly) {
      // Not sent, so it must not use up the daily allowance either.
      await store.decr(dayKey);
      throw rateLimited(
        `This recipient has reached the limit of ${limits.recipientHourly} custom emails per hour from this workspace.`,
        secondsLeftInHour,
      );
    }
  } catch (err) {
    if (err instanceof RekeyError) throw err;
    throw new RekeyError(dependencyUnavailablePayload('redis'));
  }
}
