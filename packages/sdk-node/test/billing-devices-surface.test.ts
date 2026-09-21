/**
 * The 2.2.0 public endpoints this SDK now wraps: the free-tier self-claim,
 * trial eligibility, and the end-user device surface.
 *
 * Same posture as client.test.ts: a fake `fetch`, so what is pinned is request
 * shaping (method, path, headers, body) and how the answer is decoded. The
 * HTTP wire itself is covered by the API's own server tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { Rekey, RekeyError } from '../src/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch): Rekey {
  return new Rekey({
    apiUrl: 'https://api.example.com',
    secretKey: 'rp_live_token',
    fetch: fetchImpl,
  });
}

const TOKEN = 'jwt.user.token';
const SUBSCRIPTION = { id: 'sub_1', planSlug: 'free', status: 'ACTIVE' };

describe('billing.subscribe', () => {
  it('POSTs the free-tier claim with the user token', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data: SUBSCRIPTION }));
    const client = makeClient(fetchSpy);

    await client.billing.subscribe(TOKEN);

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/billing/subscribe');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Rekey-User-Token']).toBe(TOKEN);
    expect(headers.Authorization).toBe('Bearer rp_live_token');
    // No org named: send an empty body rather than `{organizationId: undefined}`,
    // so the API applies its own active-organization fallback.
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('reports a first activation (201) as activated: true', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data: SUBSCRIPTION }));
    const result = await makeClient(fetchSpy).billing.subscribe(TOKEN);

    expect(result).toEqual({ subscription: SUBSCRIPTION, activated: true });
  });

  it('reports an already-entitled caller (200) as activated: false', async () => {
    // The body is the SAME subscription row under both codes, so the status is
    // the only thing separating "you are now on the free tier" from "you
    // already were, nothing was written or re-announced". A caller that
    // provisions starter credits on this answer must not do it twice.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: SUBSCRIPTION }));
    const result = await makeClient(fetchSpy).billing.subscribe(TOKEN);

    expect(result.activated).toBe(false);
    expect(result.subscription).toEqual(SUBSCRIPTION);
  });

  it('names the beneficiary organization when buying for a team', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data: SUBSCRIPTION }));

    await makeClient(fetchSpy).billing.subscribe(TOKEN, { organizationId: 'org_7' });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ organizationId: 'org_7' });
  });

  it('surfaces BILLING_FREE_TIER_ALREADY_CLAIMED as a typed RekeyError', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        success: false,
        error: {
          code: 'BILLING_FREE_TIER_ALREADY_CLAIMED',
          message: 'This caller already claimed the free tier for another beneficiary.',
          fix: 'Use the beneficiary that holds the claim, or buy a paid plan.',
        },
      }),
    );

    await expect(makeClient(fetchSpy).billing.subscribe(TOKEN)).rejects.toMatchObject({
      name: 'RekeyError',
      code: 'BILLING_FREE_TIER_ALREADY_CLAIMED',
      statusCode: 409,
    });
  });
});

describe('billing.getTrialEligibility', () => {
  const BODY = {
    items: [{ planSlug: 'pro', trialDays: 14, eligible: true, reason: null, redeemedAt: null, endsAt: null }],
    page: { total: 1, limit: 50, offset: 0, hasMore: false },
    policy: 'once_per_application',
    provider: 'stripe',
  };

  it('GETs the endpoint with the user token and returns the whole envelope', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: BODY }));

    const result = await makeClient(fetchSpy).billing.getTrialEligibility(TOKEN);

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/billing/trial-eligibility');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(TOKEN);
    // `policy` and `provider` ride alongside items/page; the endpoint tells
    // callers to read `provider` and re-ask when the buyer switches processor.
    expect(result.policy).toBe('once_per_application');
    expect(result.provider).toBe('stripe');
    expect(result.items[0]!.eligible).toBe(true);
  });

  it('threads the narrowing options into the query string', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: BODY }));

    await makeClient(fetchSpy).billing.getTrialEligibility(TOKEN, {
      organizationId: 'org_7',
      planSlug: 'pro',
      limit: 10,
      offset: 20,
    });

    const url = fetchSpy.mock.calls[0]![0] as string;
    const query = new URL(url).searchParams;
    expect(query.get('organizationId')).toBe('org_7');
    expect(query.get('planSlug')).toBe('pro');
    expect(query.get('limit')).toBe('10');
    expect(query.get('offset')).toBe('20');
  });

  it('sends country as the x-country header, the way getProviders does', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: BODY }));

    await makeClient(fetchSpy).billing.getTrialEligibility(TOKEN, { country: 'in' });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-country']).toBe('IN');
  });
});

describe('billing.createCheckout: allowWithoutTrial', () => {
  it('forwards the acknowledgement that turns BILLING_TRIAL_ALREADY_USED into a sale', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { url: 'https://checkout.example/session', subscription: SUBSCRIPTION, discountAmount: 0, provider: 'stripe' },
      }),
    );

    await makeClient(fetchSpy).billing.createCheckout(TOKEN, {
      planSlug: 'pro',
      successUrl: 'https://app.example.com/ok',
      cancelUrl: 'https://app.example.com/no',
      allowWithoutTrial: true,
    });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({ allowWithoutTrial: true });
  });
});

describe('devices.listMine / devices.releaseMine', () => {
  const DEVICE = {
    id: 'dev_1',
    applicationId: 'app_1',
    endUserId: 'eu_1',
    fingerprint: 'fp',
    label: "Adam's MacBook",
    status: 'ACTIVE',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-02-01T00:00:00.000Z',
    releasedAt: null,
    blockedAt: null,
    metadata: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };

  it('lists the calling end-user own devices behind their token', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { items: [DEVICE], page: { total: 1, limit: 50, offset: 0, hasMore: false } },
      }),
    );

    const page = await makeClient(fetchSpy).devices.listMine(TOKEN);

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    // The end-user surface, addressed by the token rather than by an
    // end-user id: the secret-key `/api/v1/devices?endUserId=` route reads
    // OTHER users' devices and is not what a "your machines" screen calls.
    expect(url).toBe('https://api.example.com/api/v1/users/me/devices/');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(TOKEN);
    expect(page.items[0]!.id).toBe('dev_1');
  });

  it('filters by status and pages', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { items: [], page: { total: 0, limit: 5, offset: 10, hasMore: false } },
      }),
    );

    await makeClient(fetchSpy).devices.listMine(TOKEN, { status: 'ACTIVE', limit: 5, offset: 10 });

    const query = new URL(fetchSpy.mock.calls[0]![0] as string).searchParams;
    expect(query.get('status')).toBe('ACTIVE');
    expect(query.get('limit')).toBe('5');
    expect(query.get('offset')).toBe('10');
  });

  it('releases one of the user own devices by id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { device: DEVICE, sessionsRevoked: 2 } }),
    );

    const result = await makeClient(fetchSpy).devices.releaseMine(TOKEN, 'dev_1');

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/users/me/devices/dev_1');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(TOKEN);
    expect(result.sessionsRevoked).toBe(2);
  });

  it('encodes a device id that would otherwise change the path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { device: DEVICE, sessionsRevoked: 0 } }),
    );

    await makeClient(fetchSpy).devices.releaseMine(TOKEN, 'dev/../../admin');

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'https://api.example.com/api/v1/users/me/devices/dev%2F..%2F..%2Fadmin',
    );
  });

  it('surfaces DEVICE_BLOCKED with the details a client can act on', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        success: false,
        error: {
          code: 'DEVICE_BLOCKED',
          message: 'The device is blocked.',
          fix: 'Only an operator can unblock it.',
        },
      }),
    );

    const err = await makeClient(fetchSpy)
      .devices.releaseMine(TOKEN, 'dev_1')
      .catch((e) => e as RekeyError);

    expect(err).toBeInstanceOf(RekeyError);
    expect(err.code).toBe('DEVICE_BLOCKED');
  });
});
