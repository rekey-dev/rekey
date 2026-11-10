/**
 * The store behind the hosted portal's authorization requests, against a real
 * Redis. The rest of the suite runs on the in-memory fallback (`getRedis` is
 * null under test), so this is the one place the Redis path is exercised.
 * Skipped when no REDIS_URL is set.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';

const url = process.env.REDIS_URL;
const redis = url ? new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;

vi.mock('../src/lib/redis.js', () => ({ getRedis: () => redis }));

const store = await import('../src/modules/mcp/authorization-requests.js');

const REQUEST = {
  applicationId: 'app_1',
  clientId: 'client_1',
  redirectUri: 'http://127.0.0.1:53682/callback',
  codeChallenge: 'challenge',
  scope: 'openid',
  state: 'st',
};

describe.skipIf(!redis)('authorization request store on Redis', () => {
  afterAll(async () => {
    await redis?.quit();
  });

  it('stores with the 15-minute expiry, reads without spending, and spends once', async () => {
    const id = await store.storeAuthorizationRequest(REQUEST);
    expect(id).toMatch(store.AUTHORIZATION_REQUEST_ID);
    const ttl = await redis!.ttl(`oauth:authorize-request:${id}`);
    expect(ttl).toBeGreaterThan(14 * 60);
    expect(ttl).toBeLessThanOrEqual(15 * 60);

    expect(await store.peekAuthorizationRequest(id)).toEqual(REQUEST);
    expect(await store.peekAuthorizationRequest(id)).toEqual(REQUEST);
    const answers = await Promise.all(Array.from({ length: 8 }, () => store.takeAuthorizationRequest(id)));
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(await store.peekAuthorizationRequest(id)).toBeNull();
  });

  it('never looks up an id of the wrong shape', async () => {
    const spy = vi.spyOn(redis!, 'get');
    expect(await store.peekAuthorizationRequest('oauth:pkce:x')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
