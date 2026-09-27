/**
 * The custom email send caps, as a unit: the daily window, the per-recipient
 * window, and what happens when Redis is down.
 *
 * `lib/redis.js` is mocked so the failure case exercises the Redis branch:
 * under test `getRedis()` is null and only the in-memory store would run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  client: null as null | {
    eval: (script: string, n: number, key: string, ttl: string) => Promise<number>;
    decr: () => Promise<number>;
  },
}));

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => redis.client,
  closeRedis: async () => undefined,
}));

import { consumeSendAllowance, recipientCapKey, __resetForTests } from '../src/modules/email/custom/send-caps.js';

const CAPS = { daily: 3, recipientHourly: 2 };
const NOON = new Date('2026-09-26T12:00:00Z');

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code: string }).code;
  }
}

describe('custom email send caps', () => {
  beforeEach(() => {
    redis.client = null;
    __resetForTests();
  });

  it('refuses past the per-recipient cap, without spending the daily allowance', async () => {
    await consumeSendAllowance('app_1', 'a@example.com', CAPS, NOON);
    await consumeSendAllowance('app_1', 'A@example.com', CAPS, NOON);
    const refused = consumeSendAllowance('app_1', 'a@example.com', CAPS, NOON);
    await expect(refused).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED', statusCode: 429, retryAfterSeconds: 3600 });
    // Two sent, one refused: one more to someone else still fits in the day.
    await consumeSendAllowance('app_1', 'b@example.com', CAPS, NOON);
    expect(await codeOf(consumeSendAllowance('app_1', 'c@example.com', CAPS, NOON))).toBe('EMAIL_RATE_LIMITED');
  });

  it('refuses past the daily cap until the next UTC day, per Application', async () => {
    for (const to of ['a', 'b', 'c']) await consumeSendAllowance('app_2', `${to}@example.com`, CAPS, NOON);
    const refused = consumeSendAllowance('app_2', 'd@example.com', CAPS, NOON);
    await expect(refused).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED', retryAfterSeconds: 12 * 3600 });
    await consumeSendAllowance('app_3', 'd@example.com', CAPS, NOON);
    await consumeSendAllowance('app_2', 'd@example.com', CAPS, new Date('2026-09-27T00:00:01Z'));
  });

  it('fails closed when Redis errors: 503, never an uncapped send', async () => {
    redis.client = {
      eval: () => Promise.reject(new Error('ECONNREFUSED')),
      decr: () => Promise.resolve(0),
    };
    await expect(consumeSendAllowance('app_4', 'a@example.com', CAPS, NOON)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      statusCode: 503,
    });
  });

  it('counts in Redis with one atomic INCR-and-EXPIRE script', async () => {
    const counts = new Map<string, number>();
    const scripts = new Set<string>();
    redis.client = {
      eval: async (script: string, _n: number, k: string, ttl: string) => {
        scripts.add(script);
        expect(Number(ttl)).toBeGreaterThan(0);
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return counts.get(k)!;
      },
      decr: async () => 0,
    };
    await consumeSendAllowance('app_5', 'a@example.com', CAPS, NOON);
    await consumeSendAllowance('app_5', 'a@example.com', CAPS, NOON);
    expect(await codeOf(consumeSendAllowance('app_5', 'a@example.com', CAPS, NOON))).toBe('EMAIL_RATE_LIMITED');
    expect([...counts.keys()].some((k) => k.startsWith('email:cap:day:app_5:2026-09-26'))).toBe(true);
    expect([...counts.keys()].some((k) => k.includes('a@example.com'))).toBe(false);
    expect([...scripts][0]).toContain("redis.call('EXPIRE'");
  });

  it('counts a +tagged address as its base address', async () => {
    expect(recipientCapKey('A.B+news@Example.com')).toBe('a.b@example.com');
    expect(recipientCapKey('+x@example.com')).toBe('+x@example.com');
    await consumeSendAllowance('ws_6', 'a+1@example.com', CAPS, NOON);
    await consumeSendAllowance('ws_6', 'a+2@example.com', CAPS, NOON);
    expect(await codeOf(consumeSendAllowance('ws_6', 'a@example.com', CAPS, NOON))).toBe('EMAIL_RATE_LIMITED');
  });
});
