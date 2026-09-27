/**
 * How many checkouts may be started, on either page and for every provider.
 *
 * Card testing needs a fresh processor session per batch of attempts, and each
 * session needs a checkout. Three ceilings, all rolling windows:
 *
 *   - per end-user: 10 an hour and 30 a day, the brake on one account;
 *   - per client IP (only when the address is vouched for, see
 *     lib/client-ip.ts): CHECKOUT_LIMIT_PER_IP_HOUR, default 20, because
 *     free sign-ups make fresh accounts cheap;
 *   - per Application: CHECKOUT_LIMIT_PER_APP_HOUR, default 1000, the
 *     backstop when the addresses are spread out too.
 *
 * Each window is a Redis sorted set of admission times. Admission is
 * add-then-count inside one MULTI, so a burst at the limit admits exactly as
 * many as there are slots; counting database rows would let a burst through,
 * because the row is written after the processor call. If Redis errors, the
 * per-end-user window falls back to counting `CheckoutSession` rows and the
 * other two are skipped. Without Redis at all (tests, a single-process
 * self-host) the windows live in process memory.
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RekeyError } from '../../../lib/error.js';
import { prisma } from '../../../lib/prisma.js';
import { env } from '../../../config/env.js';
import { rateLimitsEnforced } from '../../../lib/rate-limit.js';

export const CHECKOUTS_PER_HOUR = 10;
export const CHECKOUTS_PER_DAY = 30;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Window {
  ms: number;
  max: number;
}

interface Scope {
  key: string;
  windows: Window[];
  /** Who hit the limit, for the refusal's wording. */
  subject: string;
}

const memory = new Map<string, Array<{ at: number; id: string }>>();

/** One admission, returned so a failed checkout can give it back. */
export interface CheckoutSlot {
  entries: Array<{ key: string; member: string }>;
}

function rateLimited(scope: Scope, retryAt: number, now: number): RekeyError {
  const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
  const limits = scope.windows
    .map((w) => `${w.max} ${w.ms === HOUR_MS ? 'an hour' : 'a day'}`)
    .join(' and ');
  return new RekeyError({
    statusCode: 429,
    code: 'CHECKOUT_RATE_LIMITED',
    message: `Too many checkouts have been started ${scope.subject} (at most ${limits}).`,
    fix: `Retry after ${new Date(retryAt).toISOString()} (in ${seconds} seconds). Finish or abandon an open checkout instead of starting new ones.`,
  });
}

/** When the oldest admission inside the first full window leaves it, freeing a slot. */
function retryAtFor(windows: Window[], times: number[], now: number): number {
  for (const w of windows) {
    const inside = times.filter((t) => t > now - w.ms);
    if (inside.length >= w.max) return Math.min(...inside) + w.ms;
  }
  return now + 1000;
}

function isFull(windows: Window[], times: number[], now: number, includesSelf: boolean): boolean {
  return windows.some((w) => {
    const count = times.filter((t) => t > now - w.ms).length;
    return includesSelf ? count > w.max : count >= w.max;
  });
}

function longest(windows: Window[]): number {
  return Math.max(...windows.map((w) => w.ms));
}

function admitInMemory(scope: Scope, now: number): { key: string; member: string } {
  const live = (memory.get(scope.key) ?? []).filter((e) => e.at > now - longest(scope.windows));
  const times = live.map((e) => e.at);
  if (isFull(scope.windows, times, now, false)) {
    memory.set(scope.key, live);
    throw rateLimited(scope, retryAtFor(scope.windows, times, now), now);
  }
  const member = randomUUID();
  live.push({ at: now, id: member });
  memory.set(scope.key, live);
  return { key: scope.key, member };
}

async function admitInRedis(redis: Redis, scope: Scope, now: number): Promise<{ key: string; member: string }> {
  const member = `${now}:${randomUUID()}`;
  const span = longest(scope.windows);
  const replies = await redis
    .multi()
    .zremrangebyscore(scope.key, '-inf', now - span)
    .zadd(scope.key, now, member)
    .zrangebyscore(scope.key, `(${now - span}`, '+inf', 'WITHSCORES')
    .pexpire(scope.key, span)
    .exec();
  if (!replies || replies.some(([err]) => err !== null)) throw new Error('checkout limiter MULTI failed');
  const flat = replies[2]![1] as string[];
  const times = flat.filter((_, i) => i % 2 === 1).map(Number);
  if (!isFull(scope.windows, times, now, true)) return { key: scope.key, member };
  await redis.zrem(scope.key, member);
  throw rateLimited(scope, retryAtFor(scope.windows, times, now), now);
}

async function admitEndUserFromRows(scope: Scope, applicationId: string, endUserId: string, now: number): Promise<void> {
  const rows = await prisma.checkoutSession.findMany({
    where: { applicationId, endUserId, createdAt: { gt: new Date(now - DAY_MS) } },
    select: { createdAt: true },
  });
  const times = rows.map((r) => r.createdAt.getTime());
  if (isFull(scope.windows, times, now, false)) throw rateLimited(scope, retryAtFor(scope.windows, times, now), now);
}

async function release(redis: Redis | null, entry: { key: string; member: string }): Promise<void> {
  if (!redis) {
    const live = memory.get(entry.key);
    if (live) memory.set(entry.key, live.filter((e) => e.id !== entry.member));
    return;
  }
  await redis.zrem(entry.key, entry.member).catch(() => undefined);
}

/**
 * Take one checkout slot in every applicable scope, or throw 429
 * `CHECKOUT_RATE_LIMITED`. `clientIp` is null when the address cannot be
 * vouched for, which skips the per-IP ceiling rather than blocking everyone
 * behind a shared proxy.
 *
 * @example
 * const slot = await admitCheckout(getRedis(), { applicationId, endUserId, clientIp: req.clientIpVouched ? req.ip : null });
 * try { await createCheckout(); } catch (e) { await releaseCheckout(getRedis(), slot); throw e; }
 */
export async function admitCheckout(
  redis: Redis | null,
  who: { applicationId: string; endUserId: string; clientIp: string | null },
  log?: { error: (obj: object, msg: string) => void },
): Promise<CheckoutSlot> {
  const endUser: Scope = {
    key: `ckrl:eu:${who.applicationId}:${who.endUserId}`,
    windows: [
      { ms: HOUR_MS, max: CHECKOUTS_PER_HOUR },
      { ms: DAY_MS, max: CHECKOUTS_PER_DAY },
    ],
    subject: 'by this account',
  };
  const scopes: Scope[] = [endUser];
  // The shared ceilings follow the suite-wide switch the other limiters use
  // (see rateLimitsEnforced): a test file starting dozens of checkouts from
  // one address would otherwise trip them in fixtures.
  const shared = rateLimitsEnforced();
  if (shared && who.clientIp !== null) {
    scopes.push({
      key: `ckrl:ip:${who.clientIp}`,
      windows: [{ ms: HOUR_MS, max: env.CHECKOUT_LIMIT_PER_IP_HOUR }],
      subject: 'from this network address',
    });
  }
  if (shared) {
    scopes.push({
      key: `ckrl:app:${who.applicationId}`,
      windows: [{ ms: HOUR_MS, max: env.CHECKOUT_LIMIT_PER_APP_HOUR }],
      subject: 'for this Application',
    });
  }

  const now = Date.now();
  const taken: CheckoutSlot = { entries: [] };
  try {
    for (const scope of scopes) {
      if (!redis) {
        taken.entries.push(admitInMemory(scope, now));
        continue;
      }
      try {
        taken.entries.push(await admitInRedis(redis, scope, now));
      } catch (e) {
        if (e instanceof RekeyError) throw e;
        log?.error({ err: e }, 'checkout creation limiter unavailable, counting checkout sessions instead');
        if (scope === endUser) await admitEndUserFromRows(scope, who.applicationId, who.endUserId, now);
      }
    }
  } catch (e) {
    await releaseCheckout(redis, taken);
    throw e;
  }
  return taken;
}

/**
 * Give every slot back, for a checkout that failed before anything was created.
 *
 * @example
 * await releaseCheckout(getRedis(), slot);
 */
export async function releaseCheckout(redis: Redis | null, slot: CheckoutSlot): Promise<void> {
  for (const entry of slot.entries) await release(redis, entry);
}

/** Test seam: forget every admission held in memory. */
export function __resetForTests(): void {
  memory.clear();
}
