/**
 * Wire-contract tests — the places where these schemas disagreed with what the
 * API actually sends, or froze a set the API is going to grow.
 *
 * Type-level guarantees (the `Open<…>` unions, the schema/interface equality
 * assertion in src/index.ts) are enforced by `tsc` and are not repeated here.
 * What IS here is the runtime half: fields that must parse, and fields that
 * must be allowed to be absent.
 */

import { describe, expect, it } from 'vitest';
import {
  ApplicationDtoSchema,
  KNOWN_WEBHOOK_EVENTS,
  RekeyError,
  RekeyErrorSchema,
  isKnownWebhookEvent,
} from '../src/index.js';
import { RekeyError as RekeyErrorFromSubpath } from '../src/error.js';

describe('RekeyErrorSchema', () => {
  it('declares retryAfterSeconds — the API has always sent it', () => {
    // `apps/api/src/lib/rate-limit.ts` puts this on every RATE_LIMITED envelope
    // and mirrors it in `Retry-After`; the schema simply never named it, so it
    // arrived untyped and `z.object` (non-strict) dropped it on parse.
    const parsed = RekeyErrorSchema.parse({
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded. Retry in 30s.',
      fix: 'Back off for the number of seconds in the Retry-After header.',
      retryAfterSeconds: 30,
    });
    expect(parsed.retryAfterSeconds).toBe(30);
  });

  it('leaves retryAfterSeconds absent on errors that retrying will not fix', () => {
    const parsed = RekeyErrorSchema.parse({ code: 'PLAN_NOT_FOUND', message: 'nope' });
    expect(parsed.retryAfterSeconds).toBeUndefined();
  });

  it('rejects a negative or fractional retryAfterSeconds', () => {
    expect(RekeyErrorSchema.safeParse({ code: 'X', message: 'y', retryAfterSeconds: -1 }).success)
      .toBe(false);
    expect(RekeyErrorSchema.safeParse({ code: 'X', message: 'y', retryAfterSeconds: 1.5 }).success)
      .toBe(false);
  });
});

describe('RekeyError', () => {
  it('carries retryAfterSeconds through to the thrown instance', () => {
    const err = new RekeyError({ code: 'RATE_LIMITED', message: 'slow down', retryAfterSeconds: 7 });
    expect(err.retryAfterSeconds).toBe(7);
  });

  it('is the SAME class via the barrel and via the /error subpath', () => {
    // The subpath exists so browser bundles can skip zod. If it produced a
    // second class object, `instanceof` would be false across packages that
    // happened to import from different paths — a silent, un-debuggable bug.
    expect(RekeyError).toBe(RekeyErrorFromSubpath);
    expect(new RekeyErrorFromSubpath({ code: 'X', message: 'y' })).toBeInstanceOf(RekeyError);
  });

  it('preserves the underlying transport error on `cause`', () => {
    const cause = new TypeError('fetch failed');
    expect(new RekeyError({ code: 'NETWORK_ERROR', message: 'x', cause }).cause).toBe(cause);
  });
});

/** The two fields AuthConfigSchema has no default for. Not what is under test. */
const MINIMAL_AUTH_CONFIG = { methods: ['password'], redirectUrls: [] };

describe('ApplicationDtoSchema', () => {
  it('parses the body GET /api/v1/me actually returns — no `environment`', () => {
    // `apps/api/src/routes/me.ts` omits `environment` entirely. The field was
    // declared required, so `rekey.applications.me()` returned `undefined`
    // typed as a guaranteed enum, and a strict parse would have thrown.
    const body = {
      id: 'app_1',
      tenantId: 'tn_1',
      name: 'Acme',
      slug: 'acme',
      publicKey: 'rp_pub_x',
      authConfig: MINIMAL_AUTH_CONFIG,
      billingConfig: { provider: 'stripe' },
      createdAt: new Date().toISOString(),
    };
    const parsed = ApplicationDtoSchema.parse(body);
    expect(parsed.environment).toBeUndefined();
  });

  it('still accepts an `environment` when a deployment does send one', () => {
    const parsed = ApplicationDtoSchema.parse({
      id: 'app_1',
      tenantId: 'tn_1',
      name: 'Acme',
      slug: 'acme',
      environment: 'PRODUCTION',
      publicKey: 'rp_pub_x',
      authConfig: MINIMAL_AUTH_CONFIG,
      billingConfig: { provider: 'stripe' },
      createdAt: new Date().toISOString(),
    });
    expect(parsed.environment).toBe('PRODUCTION');
  });
});

describe('open unions', () => {
  it('narrows an unknown webhook event out of the registry at runtime', () => {
    // The TYPE is open so a consumer's switch needs a default branch; the
    // registry stays closed, and this guard is how you get back to it.
    expect(isKnownWebhookEvent('user.created')).toBe(true);
    expect(isKnownWebhookEvent('subscription.trialing')).toBe(false);
    expect(KNOWN_WEBHOOK_EVENTS).toContain('user.created');
  });
});
