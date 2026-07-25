/**
 * Error-contract unit tests — the pure helpers behind docs/errors.md.
 *
 * These pin the four places the contract was previously wrong:
 *   - a 429 that claimed `BAD_REQUEST` and told a throttled caller to debug
 *     its payload, with the `retryAfterSeconds` the docs promised absent;
 *   - one identical `INTERNAL_ERROR` for every dependency outage, so an
 *     operator (who IS support when self-hosting) could not tell Redis-down
 *     from Postgres-down;
 *   - an auth limiter keyed on the API key alone, i.e. one bucket for every
 *     end user of an Application;
 *   - `req-1`-style sequential request ids that restart on every boot.
 */

import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  dependencyUnavailablePayload,
  normalizeFastifyError,
} from '../src/lib/error.js';
import { classifyDependencyOutage } from '../src/lib/dependency-outage.js';
import {
  authIdentityOf,
  authCeilingKey,
  authRateLimitKey,
  rateLimitedAfter,
  wantsAuthCeiling,
  authRateLimit,
} from '../src/lib/rate-limit.js';
import {
  MAX_INBOUND_REQUEST_ID_LENGTH,
  generateRequestId,
  normalizeInboundRequestId,
  requestIdFor,
} from '../src/lib/request-id.js';

function req(overrides: Record<string, unknown>): FastifyRequest {
  return overrides as unknown as FastifyRequest;
}

// ---------- 429 contract ----------

describe('rate-limit error envelope', () => {
  it('emits RATE_LIMITED, not BAD_REQUEST', () => {
    const err = rateLimitedAfter(54_000, 10);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.statusCode).toBe(429);
  });

  it('carries retryAfterSeconds — the field docs/errors.md promised', () => {
    // ttl is milliseconds; round UP so a client never retries a moment early.
    expect(rateLimitedAfter(54_000, 10).retryAfterSeconds).toBe(54);
    expect(rateLimitedAfter(54_400, 10).retryAfterSeconds).toBe(55);
  });

  it('never reports 0 seconds — that invites a hot retry loop', () => {
    expect(rateLimitedAfter(0, 10).retryAfterSeconds).toBe(1);
    expect(rateLimitedAfter(120, 10).retryAfterSeconds).toBe(1);
  });

  it('points the fix at Retry-After, not at the request payload', () => {
    const fix = rateLimitedAfter(30_000, 10).fix ?? '';
    expect(fix).toMatch(/Retry-After/);
    // The old fix ("Check the request shape against the route schema") sent a
    // throttled caller to debug a payload that was fine.
    expect(fix).not.toMatch(/route schema/);
  });
});

// ---------- Dependency outages ----------

describe('classifyDependencyOutage', () => {
  it('maps Prisma connection codes to postgres', () => {
    expect(classifyDependencyOutage(Object.assign(new Error('x'), { code: 'P1001' }))).toBe(
      'postgres',
    );
    expect(classifyDependencyOutage(Object.assign(new Error('x'), { code: 'P1017' }))).toBe(
      'postgres',
    );
    expect(
      classifyDependencyOutage(
        Object.assign(new Error('x'), { name: 'PrismaClientInitializationError' }),
      ),
    ).toBe('postgres');
  });

  it('leaves ordinary Prisma query errors alone (they are not outages)', () => {
    // P2002 = unique constraint. A 503 "database unreachable" would be a lie.
    expect(classifyDependencyOutage(Object.assign(new Error('x'), { code: 'P2002' }))).toBeNull();
  });

  it('maps ioredis command rejections to redis', () => {
    expect(
      classifyDependencyOutage(
        new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      ),
    ).toBe('redis');
    expect(classifyDependencyOutage(new Error('Connection is closed.'))).toBe('redis');
    expect(
      classifyDependencyOutage(new Error('Reached the max retries per request limit')),
    ).toBe('redis');
  });

  it('maps a socket-level connect failure to redis', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
    });
    expect(classifyDependencyOutage(err)).toBe('redis');
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
    });
    expect(classifyDependencyOutage(dns)).toBe('redis');
  });

  it('refuses to blame a local dependency for an outbound provider failure', () => {
    // Same socket codes, different cause. Telling an operator "your Redis is
    // down" when Stripe is unreachable sends them to restart the wrong process.
    const stripe = Object.assign(new Error('connect ECONNREFUSED'), {
      name: 'StripeConnectionError',
      code: 'ECONNREFUSED',
      syscall: 'connect',
    });
    expect(classifyDependencyOutage(stripe)).toBeNull();
    // undici/fetch wraps the real socket error in `cause`.
    const fetchFail = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
        syscall: 'connect',
      }),
    });
    expect(classifyDependencyOutage(fetchFail)).toBeNull();
  });

  it('classifies nothing for a plain application bug', () => {
    expect(classifyDependencyOutage(new Error('undefined is not a function'))).toBeNull();
    expect(classifyDependencyOutage(undefined)).toBeNull();
    expect(classifyDependencyOutage('boom')).toBeNull();
  });
});

describe('dependencyUnavailablePayload', () => {
  it('is a distinct 503 code, not INTERNAL_ERROR', () => {
    const pg = dependencyUnavailablePayload('postgres');
    expect(pg.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(pg.statusCode).toBe(503);
  });

  it('names the subsystem so Redis-down and Postgres-down differ', () => {
    const pg = dependencyUnavailablePayload('postgres');
    const redis = dependencyUnavailablePayload('redis');
    expect(pg.message).toMatch(/PostgreSQL/);
    expect(redis.message).toMatch(/Redis/);
    // The whole point: the two bodies used to be byte-identical.
    expect(pg.message).not.toBe(redis.message);
  });

  it('points at /health/ready rather than at "support"', () => {
    for (const subsystem of ['postgres', 'redis'] as const) {
      expect(dependencyUnavailablePayload(subsystem).fix).toMatch(/\/health\/ready/);
      expect(dependencyUnavailablePayload(subsystem).fix).not.toMatch(/support/i);
    }
  });

  it('leaks no connection string, credential, host, or port', () => {
    for (const subsystem of ['postgres', 'redis'] as const) {
      const rendered = JSON.stringify(dependencyUnavailablePayload(subsystem));
      expect(rendered).not.toMatch(/postgres:\/\/|redis:\/\/|@|password|:5432|:6379/);
    }
  });

  it('is retryable', () => {
    expect(dependencyUnavailablePayload('redis').retryAfterSeconds).toBeGreaterThan(0);
  });
});

// ---------- Fastify-internal code normalisation ----------

describe('normalizeFastifyError', () => {
  it('maps validation failures to the documented BAD_REQUEST', () => {
    expect(normalizeFastifyError('FST_ERR_VALIDATION').code).toBe('BAD_REQUEST');
    expect(normalizeFastifyError('FST_ERR_CTP_INVALID_JSON_BODY').code).toBe('BAD_REQUEST');
  });

  it('maps media-type failures to UNSUPPORTED_MEDIA_TYPE', () => {
    const mapped = normalizeFastifyError('FST_ERR_CTP_INVALID_MEDIA_TYPE');
    expect(mapped.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(mapped.fix).toBe('Send Content-Type: application/json');
    expect(normalizeFastifyError('FST_ERR_CTP_EMPTY_TYPE').code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('maps a body over the limit to PAYLOAD_TOO_LARGE', () => {
    expect(normalizeFastifyError('FST_ERR_CTP_BODY_TOO_LARGE').code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('never lets an unmapped FST_ERR_* code escape as the public code', () => {
    // Framework identifiers are not part of our contract; docs/errors.md
    // documents BAD_REQUEST as the catch-all for Fastify-native 4xx.
    expect(normalizeFastifyError('FST_ERR_CTP_SOMETHING_NEW').code).toBe('BAD_REQUEST');
    expect(normalizeFastifyError(undefined).code).toBe('BAD_REQUEST');
  });

  it('passes through a non-Fastify code untouched', () => {
    expect(normalizeFastifyError('IDEMPOTENCY_KEY_INVALID').code).toBe('IDEMPOTENCY_KEY_INVALID');
  });
});

// ---------- Auth limiter keying ----------

describe('authIdentityOf', () => {
  it('lowercases and trims the email', () => {
    expect(authIdentityOf({ email: '  Alice@Example.COM ' })).toBe('alice@example.com');
  });

  it('never throws on an absent or malformed body', () => {
    // This runs on unvalidated input at preValidation — a throw here would
    // 500 every auth request with a weird body.
    expect(authIdentityOf(undefined)).toBe('-');
    expect(authIdentityOf(null)).toBe('-');
    expect(authIdentityOf('not-an-object')).toBe('-');
    expect(authIdentityOf([])).toBe('-');
    expect(authIdentityOf({})).toBe('-');
    expect(authIdentityOf({ email: 42 })).toBe('-');
    expect(authIdentityOf({ email: null })).toBe('-');
    expect(authIdentityOf({ email: {} })).toBe('-');
    expect(authIdentityOf({ email: '   ' })).toBe('-');
  });

  it('bounds the key fragment and strips the key separator', () => {
    const huge = 'a'.repeat(5_000) + '@example.com';
    expect(authIdentityOf({ email: huge }).length).toBeLessThanOrEqual(254);
    // A ':' in the identity would let a caller forge a neighbouring bucket key.
    expect(authIdentityOf({ email: 'a:b@example.com' })).toBe('ab@example.com');
  });
});

describe('authRateLimitKey', () => {
  const apiKey = { id: 'key_1' } as FastifyRequest['apiKey'];

  it('gives two end users of ONE Application separate buckets', () => {
    // The regression: `req.apiKey?.id ?? req.ip` meant sign-in shared a single
    // 10-per-60s bucket across every end user, so ten failed logins a minute
    // (ordinary traffic) locked the whole app out for the window.
    const a = authRateLimitKey(req({ apiKey, ip: '1.2.3.4', body: { email: 'a@example.com' } }));
    const b = authRateLimitKey(req({ apiKey, ip: '1.2.3.4', body: { email: 'b@example.com' } }));
    expect(a).not.toBe(b);
  });

  it('keeps the same identity in the same bucket, case-insensitively', () => {
    const a = authRateLimitKey(req({ apiKey, ip: '1.2.3.4', body: { email: 'a@example.com' } }));
    const b = authRateLimitKey(req({ apiKey, ip: '1.2.3.4', body: { email: 'A@Example.com' } }));
    expect(a).toBe(b);
  });

  it('still separates Applications and source IPs', () => {
    const base = { ip: '1.2.3.4', body: { email: 'a@example.com' } };
    const other = { id: 'key_2' } as FastifyRequest['apiKey'];
    expect(authRateLimitKey(req({ ...base, apiKey }))).not.toBe(
      authRateLimitKey(req({ ...base, apiKey: other })),
    );
    expect(authRateLimitKey(req({ ...base, apiKey }))).not.toBe(
      authRateLimitKey(req({ ...base, apiKey, ip: '5.6.7.8' })),
    );
  });

  it('falls back to a per-IP bucket for unauthenticated auth routes', () => {
    // Operator sign-in carries no API key.
    const key = authRateLimitKey(req({ ip: '1.2.3.4', body: { email: 'op@example.com' } }));
    expect(key).toContain('anon');
    expect(key).toContain('1.2.3.4');
  });
});

describe('per-Application auth ceiling', () => {
  it('is requested by every authRateLimit() route', () => {
    expect(wantsAuthCeiling(authRateLimit(10))).toBe(true);
  });

  it('is not requested by an ordinary route config', () => {
    expect(wantsAuthCeiling(undefined)).toBe(false);
    expect(wantsAuthCeiling(false)).toBe(false);
    expect(wantsAuthCeiling({ max: 10, timeWindow: '1 minute' })).toBe(false);
  });

  it('aggregates per Application, independent of identity', () => {
    const apiKey = { id: 'key_1' } as FastifyRequest['apiKey'];
    const a = authCeilingKey(req({ apiKey, ip: '1.2.3.4', body: { email: 'a@example.com' } }));
    const b = authCeilingKey(req({ apiKey, ip: '9.9.9.9', body: { email: 'b@example.com' } }));
    expect(a).toBe(b);
    expect(a).not.toBe(authCeilingKey(req({ apiKey: { id: 'key_2' } as FastifyRequest['apiKey'], ip: '1.2.3.4', body: {} })));
  });

  it('does not collide with the tight per-identity bucket', () => {
    const r = req({ apiKey: { id: 'key_1' } as FastifyRequest['apiKey'], ip: '1.2.3.4', body: {} });
    expect(authCeilingKey(r)).not.toBe(authRateLimitKey(r));
  });

  it('runs the tight limiter after body parsing', () => {
    // keyGenerator reads req.body, so the hook cannot be onRequest.
    expect(authRateLimit(10).hook).toBe('preValidation');
  });
});

// ---------- Request ids ----------

describe('request ids', () => {
  it('are collision-resistant, not a per-boot counter', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateRequestId()));
    expect(ids.size).toBe(500);
    // The old ids were `req-1`, `req-f`, `req-ea` — restarting at 1 each boot.
    for (const id of ids) expect(id).not.toMatch(/^req-/);
  });

  it('honours an inbound X-Request-Id for trace continuity', () => {
    const inbound = '0af7651916cd43dd8448eb211c80319c';
    expect(requestIdFor({ 'x-request-id': inbound })).toBe(inbound);
  });

  it('mints a fresh id when none is supplied', () => {
    expect(requestIdFor({})).not.toBe(requestIdFor({}));
    expect(requestIdFor(undefined)).toBeTruthy();
  });

  it('strips characters that could poison a log line', () => {
    expect(normalizeInboundRequestId('abc\ndef')).toBe('abcdef');
    expect(normalizeInboundRequestId('a b\tc')).toBe('abc');
    expect(normalizeInboundRequestId('a"b\'c<d>')).toBe('abcd');
    expect(normalizeInboundRequestId('a b')).toBe('ab');
  });

  it('caps inbound length', () => {
    const id = requestIdFor({ 'x-request-id': 'z'.repeat(5_000) });
    expect(id.length).toBe(MAX_INBOUND_REQUEST_ID_LENGTH);
  });

  it('mints a fresh id when the inbound one sanitises to nothing', () => {
    expect(normalizeInboundRequestId('\n\n')).toBeNull();
    expect(normalizeInboundRequestId('')).toBeNull();
    expect(normalizeInboundRequestId(42)).toBeNull();
    expect(requestIdFor({ 'x-request-id': '   ' })).toBeTruthy();
  });

  it('takes the first value when the header is repeated', () => {
    expect(requestIdFor({ 'x-request-id': ['first', 'second'] })).toBe('first');
  });
});
