/**
 * The Redis half of MFA replay resistance.
 *
 * `mfa-replay.test.ts` drives the full flows, but under test `getRedis()` is
 * null, so those run on the in-memory fallback. Production runs the Lua step
 * claim and the SET NX challenge claim, so these talk to a real Redis
 * (REDIS_URL, provided in CI) and race them directly.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import {
  claimMfaChallenge,
  claimTotpStep,
  isMfaChallengeSpent,
  isTotpStepSpent,
} from '../src/lib/mfa-replay.js';

const RACERS = 8;
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
let redis: Redis;

const unique = (): string => randomBytes(16).toString('hex');
const inFiveMinutes = (): number => Math.floor(Date.now() / 1000) + 300;

beforeAll(() => {
  redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
});

afterAll(async () => {
  await redis.quit();
});

describe('MFA replay store on Redis', () => {
  it(`${RACERS} concurrent claims of one TOTP step: exactly one wins`, async () => {
    const secret = unique();
    const results = await Promise.all(
      Array.from({ length: RACERS }, () => claimTotpStep(secret, 1000, redis)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses an older step once a newer one is accepted, and takes the next one', async () => {
    const secret = unique();
    expect(await claimTotpStep(secret, 1001, redis)).toBe(true);
    expect(await claimTotpStep(secret, 1000, redis)).toBe(false);
    expect(await claimTotpStep(secret, 1001, redis)).toBe(false);
    expect(await claimTotpStep(secret, 1002, redis)).toBe(true);
  });

  it('reads whether a step is spent without claiming it', async () => {
    const secret = unique();
    expect(await isTotpStepSpent(secret, 1000, redis)).toBe(false);
    expect(await isTotpStepSpent(secret, 1000, redis)).toBe(false);
    await claimTotpStep(secret, 1000, redis);
    expect(await isTotpStepSpent(secret, 999, redis)).toBe(true);
    expect(await isTotpStepSpent(secret, 1000, redis)).toBe(true);
    expect(await isTotpStepSpent(secret, 1001, redis)).toBe(false);
  });

  it('keeps the step record past the window, plus one period for replica clock skew', async () => {
    const secret = unique();
    await claimTotpStep(secret, 1000, redis);
    const key = `mfa:totp-step:${createHash('sha256').update(secret).digest('hex')}`;
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(90);
    expect(ttl).toBeLessThanOrEqual(120);
    const keys = await redis.keys('mfa:totp-step:*');
    expect(keys.some((k) => k.includes(secret))).toBe(false);
  });

  it(`${RACERS} concurrent claims of one challenge token: exactly one wins`, async () => {
    const token = unique();
    expect(await isMfaChallengeSpent(token, redis)).toBe(false);
    const results = await Promise.all(
      Array.from({ length: RACERS }, () => claimMfaChallenge(token, inFiveMinutes(), redis)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await isMfaChallengeSpent(token, redis)).toBe(true);
  });

  it('fails closed with 503 when Redis is unreachable', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      connectTimeout: 200,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    dead.on('error', () => undefined);
    try {
      await expect(claimTotpStep(unique(), 1, dead)).rejects.toMatchObject({
        statusCode: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
      });
      await expect(claimMfaChallenge(unique(), inFiveMinutes(), dead)).rejects.toMatchObject({
        statusCode: 503,
      });
      await expect(isMfaChallengeSpent(unique(), dead)).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      dead.disconnect();
    }
  });
});
