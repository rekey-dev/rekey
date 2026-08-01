/**
 * SDK unit tests — request shaping, config validation, error decoding.
 *
 * Uses a fake `fetch` so the suite is hermetic and fast. End-to-end coverage
 * of the actual HTTP wire lives in apps/api server tests; we don't duplicate
 * that here — instead we pin the contract on each side independently.
 */

import { describe, expect, it, vi } from 'vitest';
import { Rekey, RekeyError } from '../src/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Rekey constructor', () => {
  const fakeFetch = vi.fn();

  it('throws CONFIG_MISSING_API_URL when apiUrl is empty', () => {
    expect(() => new Rekey({ apiUrl: '', secretKey: 'rp_live_x' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_MISSING_API_URL' }),
    );
  });

  it('throws CONFIG_INVALID_SECRET_KEY when key does not start with rp_', () => {
    expect(
      () => new Rekey({ apiUrl: 'https://x', secretKey: 'sk_live_definitely_stripe' }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID_SECRET_KEY' }));
  });

  it('strips trailing slash from apiUrl so request paths join cleanly', async () => {
    const client = new Rekey({
      apiUrl: 'https://api.example.com/',
      secretKey: 'rp_live_token',
      fetch: fakeFetch,
    });
    fakeFetch.mockResolvedValueOnce(jsonResponse(200, { success: true, data: {} }));

    await client.applications.me().catch(() => undefined);

    expect(fakeFetch.mock.calls[0]![0]).toBe('https://api.example.com/api/v1/me/');
  });
});

describe('applications.me()', () => {
  function makeClient(fetchImpl: typeof fetch): Rekey {
    return new Rekey({
      apiUrl: 'https://api.example.com',
      secretKey: 'rp_live_token',
      fetch: fetchImpl,
    });
  }

  it('sends Authorization: Bearer with the secret key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { id: 'app_1', slug: 'demo' } }),
    );
    const client = makeClient(fetchSpy);
    await client.applications.me();

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rp_live_token');
    expect(init.method).toBe('GET');
  });

  it('returns the unwrapped data on success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { id: 'app_1', slug: 'demo', name: 'Demo' },
      }),
    );
    const client = makeClient(fetchSpy);
    const me = await client.applications.me();
    expect(me).toEqual({ id: 'app_1', slug: 'demo', name: 'Demo' });
  });

  it('throws RekeyError carrying server-supplied code/message/fix', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        success: false,
        error: {
          code: 'API_KEY_INVALID',
          message: 'API key is unknown, revoked, or expired.',
          fix: 'List your active keys with the panel; if needed, mint a new one.',
        },
      }),
    );
    const client = makeClient(fetchSpy);

    await expect(client.applications.me()).rejects.toMatchObject({
      name: 'RekeyError',
      code: 'API_KEY_INVALID',
      fix: 'List your active keys with the panel; if needed, mint a new one.',
      statusCode: 401,
    });
  });

  it('falls back to UNKNOWN_ERROR when the server returns a non-envelope failure', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('plain text', { status: 502 }));
    const client = makeClient(fetchSpy);

    const err = await client.applications.me().catch((e) => e as RekeyError);
    expect(err).toBeInstanceOf(RekeyError);
    expect(err.code).toBe('UNKNOWN_ERROR');
    expect(err.statusCode).toBe(502);
  });
});

describe('auth.signUp / signIn / getCurrentUser', () => {
  function makeClient(fetchImpl: typeof fetch): Rekey {
    return new Rekey({
      apiUrl: 'https://api.example.com',
      secretKey: 'rp_live_token',
      fetch: fetchImpl,
    });
  }

  it('signUp POSTs the body to /api/v1/auth/sign-up and returns access + refresh tokens', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        success: true,
        data: {
          endUser: { id: 'eu_1', email: 'a@b.co' },
          accessToken: 'jwt.access.here',
          accessTokenExpiresAt: '2026-12-31T00:00:00.000Z',
          refreshToken: 'rt-opaque',
          refreshTokenExpiresAt: '2027-01-30T00:00:00.000Z',
        },
      }),
    );
    const client = makeClient(fetchSpy);
    const result = await client.auth.signUp({ email: 'a@b.co', password: 'pw-one-two-three' });

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/auth/sign-up');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.co', password: 'pw-one-two-three' });
    expect(result.accessToken).toBe('jwt.access.here');
    expect(result.refreshToken).toBe('rt-opaque');
  });

  it('refresh POSTs the refresh token and returns a new pair', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: {
          endUser: { id: 'eu_1', email: 'a@b.co' },
          accessToken: 'jwt.new',
          accessTokenExpiresAt: '2026-12-31T00:00:00.000Z',
          refreshToken: 'rt-new',
          refreshTokenExpiresAt: '2027-01-30T00:00:00.000Z',
        },
      }),
    );
    const client = makeClient(fetchSpy);
    const result = await client.auth.refresh('rt-old');
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/auth/refresh');
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'rt-old' });
    expect(result.refreshToken).toBe('rt-new');
  });

  it('refresh surfaces REFRESH_TOKEN_REUSED as a typed error so callers can react to compromise', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        success: false,
        error: {
          code: 'REFRESH_TOKEN_REUSED',
          message: 'Refresh token has already been used.',
          fix: 'A used refresh token cannot be replayed. Sign the user in again.',
        },
      }),
    );
    const client = makeClient(fetchSpy);
    await expect(client.auth.refresh('replayed')).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
      statusCode: 401,
    });
  });

  it('billing.getPlans GETs /api/v1/billing/plans (no user JWT needed)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: [{ slug: 'pro_monthly', amount: 999 }] }),
    );
    const client = makeClient(fetchSpy);
    const plans = await client.billing.getPlans();
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/billing/plans');
    expect(init.method).toBe('GET');
    // No X-Rekey-User-Token on the public plan list.
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBeUndefined();
    expect(plans).toHaveLength(1);
  });

  it('billing.getSubscription passes the user JWT and returns null when none', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { success: true, data: null }));
    const client = makeClient(fetchSpy);
    const sub = await client.billing.getSubscription('user.access.token');
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/billing/subscription');
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(
      'user.access.token',
    );
    expect(sub).toBeNull();
  });

  it('billing.createCheckout POSTs body + user JWT and returns {url, subscription, discountAmount}', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: {
          url: 'https://checkout.stripe.example/cs_xxx',
          subscription: { id: 'sub_1', status: 'PENDING' },
          discountAmount: 0,
        },
      }),
    );
    const client = makeClient(fetchSpy);
    const result = await client.billing.createCheckout('user.access.token', {
      planSlug: 'pro_monthly',
      successUrl: 'https://x.example/ok',
      cancelUrl: 'https://x.example/cancel',
    });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/billing/checkout');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      planSlug: 'pro_monthly',
      successUrl: 'https://x.example/ok',
      cancelUrl: 'https://x.example/cancel',
    });
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(
      'user.access.token',
    );
    expect(result.url).toMatch(/^https:\/\/checkout\.stripe\.example\//);
    expect(result.discountAmount).toBe(0);
  });

  it('billing.createCheckout forwards couponCode when provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: {
          url: 'https://x',
          subscription: { id: 's', status: 'PENDING' },
          discountAmount: 499,
        },
      }),
    );
    const client = makeClient(fetchSpy);
    await client.billing.createCheckout('user.access.token', {
      planSlug: 'pro_monthly',
      successUrl: 'https://x.example/ok',
      cancelUrl: 'https://x.example/cancel',
      couponCode: 'LAUNCH50',
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string).couponCode).toBe('LAUNCH50');
  });

  it('billing.validateCoupon POSTs to /coupons/validate with the user JWT', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: {
          coupon: { code: 'launch50' },
          plan: { slug: 'pro_monthly', name: 'Pro', amount: 999, currency: 'USD' },
          discountAmount: 499,
          amountAfterDiscount: 500,
        },
      }),
    );
    const client = makeClient(fetchSpy);
    const r = await client.billing.validateCoupon('user.access.token', {
      code: 'LAUNCH50',
      planSlug: 'pro_monthly',
    });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/billing/coupons/validate');
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(
      'user.access.token',
    );
    expect(r.discountAmount).toBe(499);
  });

  it('billing.cancelSubscription POSTs to /subscription/cancel with the user JWT', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { id: 'sub_1', status: 'ACTIVE', cancelAt: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const client = makeClient(fetchSpy);
    const sub = await client.billing.cancelSubscription('user.access.token');
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/billing/subscription/cancel');
    expect(init.method).toBe('POST');
    // Empty body, not `{atPeriodEnd: undefined}` — the API's own default is
    // cancel-at-period-end and the SDK must not talk it out of that.
    expect(JSON.parse(init.body as string)).toEqual({});
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(
      'user.access.token',
    );
    // Provider-backed rows stay ACTIVE with cancelAt set until the webhook.
    expect(sub.cancelAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('billing.cancelSubscription forwards atPeriodEnd:false and organizationId', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { id: 'sub_1', status: 'CANCELED' } }),
    );
    const client = makeClient(fetchSpy);
    await client.billing.cancelSubscription('user.access.token', {
      atPeriodEnd: false,
      organizationId: 'org_9',
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      atPeriodEnd: false,
      organizationId: 'org_9',
    });
  });

  it('signOut POSTs the refresh token and returns a {signedOut:true} envelope', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { signedOut: true } }),
    );
    const client = makeClient(fetchSpy);
    const result = await client.auth.signOut('rt-x');
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/auth/sign-out');
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'rt-x' });
    expect(result).toEqual({ signedOut: true });
  });

  it('requestPasswordReset POSTs to /forgot-password and unwraps the result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { delivered: true, resetToken: 'rt-opaque' },
      }),
    );
    const client = makeClient(fetchSpy);
    const r = await client.auth.requestPasswordReset({ email: 'a@b.co' });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/auth/forgot-password');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.co' });
    expect(r.resetToken).toBe('rt-opaque');
  });

  it('resetPassword POSTs to /reset-password', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { ok: true } }),
    );
    const client = makeClient(fetchSpy);
    const r = await client.auth.resetPassword({ token: 'rt', newPassword: 'fresh-passphrase' });
    expect(r).toEqual({ ok: true });
  });

  it('changePassword passes the user JWT in X-Rekey-User-Token', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { ok: true } }),
    );
    const client = makeClient(fetchSpy);
    await client.auth.changePassword('user.access.token', {
      currentPassword: 'old',
      newPassword: 'fresh-passphrase',
    });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/auth/change-password');
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(
      'user.access.token',
    );
  });

  it('signOutEverywhere POSTs without a body, with the user JWT', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { revokedCount: 3 } }),
    );
    const client = makeClient(fetchSpy);
    const r = await client.auth.signOutEverywhere('user.access.token');
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/auth/sign-out-everywhere');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(
      'user.access.token',
    );
    expect(r.revokedCount).toBe(3);
  });

  it('signIn surfaces INVALID_CREDENTIALS as a typed RekeyError', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is incorrect.',
          fix: 'Double-check the credentials.',
        },
      }),
    );
    const client = makeClient(fetchSpy);
    await expect(
      client.auth.signIn({ email: 'a@b.co', password: 'wrong' }),
    ).rejects.toMatchObject({
      name: 'RekeyError',
      code: 'INVALID_CREDENTIALS',
      statusCode: 401,
    });
  });

  it('getCurrentUser passes the JWT in X-Rekey-User-Token, not in Authorization', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { id: 'eu_1', email: 'a@b.co' },
      }),
    );
    const client = makeClient(fetchSpy);
    await client.auth.getCurrentUser('user.jwt.value');

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/users/me/');
    const headers = init.headers as Record<string, string>;
    // Authorization carries the SECRET key, not the user JWT — the user JWT goes in its own header.
    expect(headers.Authorization).toBe('Bearer rp_live_token');
    expect(headers['X-Rekey-User-Token']).toBe('user.jwt.value');
  });
});

describe('WEBHOOK_EVENTS registry', () => {
  it('exports the full event list, matching the API registry (names + order)', async () => {
    const { WEBHOOK_EVENTS, KNOWN_WEBHOOK_EVENTS, isKnownWebhookEvent } = await import(
      '../src/index.js'
    );
    // Must mirror apps/api/src/modules/webhooks/events.ts KNOWN_WEBHOOK_EVENTS exactly.
    expect(KNOWN_WEBHOOK_EVENTS).toEqual([
      'user.created',
      'user.updated',
      'user.deleted',
      'user.erased',
      'session.revoked',
      'mfa.enabled',
      'mfa.disabled',
      'password.changed',
      'email.verified',
      'subscription.activated',
      'subscription.canceled',
      'subscription.past_due',
      'payment.succeeded',
      'payment.failed',
      'dunning.case_opened',
      'dunning.case_recovered',
      'dunning.case_exhausted',
    ]);
    expect(WEBHOOK_EVENTS.map((e) => e.name)).toEqual(KNOWN_WEBHOOK_EVENTS);
    // Every entry carries a non-empty description for picker/autocomplete UIs.
    for (const e of WEBHOOK_EVENTS) expect(e.description.length).toBeGreaterThan(10);
    expect(isKnownWebhookEvent('payment.succeeded')).toBe(true);
    expect(isKnownWebhookEvent('payment.exploded')).toBe(false);
  });
});
