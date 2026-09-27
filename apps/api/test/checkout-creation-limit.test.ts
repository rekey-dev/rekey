/**
 * The checkout creation limits on their Redis path.
 *
 * The suite runs with Redis switched off (`getRedis()` is null under test), so
 * the wire tests in checkout-sessions.test.ts exercise the in-memory windows.
 * This file drives the Redis windows directly against a real server when one
 * is reachable at TEST_REDIS_URL, and the fallback to counting rows when the
 * server errors.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { admitCheckout, releaseCheckout, CHECKOUTS_PER_HOUR } from '../src/modules/billing/checkout/creation-limit.js';

const url = process.env.TEST_REDIS_URL;
const redis = url ? new Redis(url, { maxRetriesPerRequest: 1 }) : null;

afterAll(async () => {
  await redis?.quit();
});

function who(endUserId: string, clientIp: string | null = null) {
  return { applicationId: `app-${randomUUID()}`, endUserId, clientIp };
}

describe.skipIf(redis === null)('checkout creation limit, Redis window', () => {
  afterEach(() => {
    delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
  });

  it('admits exactly the hourly limit out of a concurrent burst', async () => {
    const buyer = who(`eu-${randomUUID()}`);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => admitCheckout(redis, buyer)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(CHECKOUTS_PER_HOUR);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(20 - CHECKOUTS_PER_HOUR);
    expect((refused[0]!.reason as { code: string }).code).toBe('CHECKOUT_RATE_LIMITED');
  });

  it('frees a slot when a failed checkout gives it back', async () => {
    const buyer = who(`eu-${randomUUID()}`);
    const slots = [];
    for (let i = 0; i < CHECKOUTS_PER_HOUR; i++) slots.push(await admitCheckout(redis, buyer));
    await expect(admitCheckout(redis, buyer)).rejects.toMatchObject({ code: 'CHECKOUT_RATE_LIMITED' });
    await releaseCheckout(redis, slots[0]!);
    await expect(admitCheckout(redis, buyer)).resolves.toBeDefined();
  });

  it('holds the per-IP ceiling across fresh accounts under a concurrent burst', async () => {
    process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const app = `app-${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => admitCheckout(redis, { applicationId: app, endUserId: `eu-${randomUUID()}`, clientIp: ip })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
  });
});

describe('checkout creation limit, Redis unavailable', () => {
  it('falls back to counting checkout sessions instead of failing open or closed', async () => {
    const broken = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    broken.on('error', () => undefined);
    const errors: unknown[] = [];
    const slot = await admitCheckout(broken, who(`eu-${randomUUID()}`), { error: (obj) => errors.push(obj) });
    expect(slot.entries).toEqual([]);
    expect(errors).toHaveLength(1);
    broken.disconnect();
  });
});
