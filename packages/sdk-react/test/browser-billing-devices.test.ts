/**
 * `RekeyBrowserClient`'s 2.2.0 self-service surface: the free-tier claim, trial
 * eligibility, and the end-user device list.
 *
 * These are the calls that make a BACKENDLESS portal possible, so what is
 * pinned is the two-credential shape: the publishable key identifies the app,
 * the user's own token authorizes the act, and the secret key is nowhere near
 * the browser. A fake `fetch` keeps it hermetic.
 */

import { describe, expect, it, vi } from 'vitest';
import { RekeyBrowserClient, RekeyError } from '../src/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch): RekeyBrowserClient {
  return new RekeyBrowserClient({
    apiUrl: 'https://api.example.com',
    publishableKey: 'rp_pub_demo',
    fetch: fetchImpl,
  });
}

const TOKEN = 'jwt.user.token';
const SUBSCRIPTION = { id: 'sub_1', planSlug: 'free', status: 'ACTIVE' };

describe('subscribe', () => {
  it('sends the publishable key AND the user token, never a secret', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data: SUBSCRIPTION }));

    await makeClient(fetchSpy).subscribe(TOKEN);

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/billing/subscribe');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer rp_pub_demo');
    expect(headers['X-Rekey-User-Token']).toBe(TOKEN);
  });

  it('distinguishes a first activation (201) from an already-entitled caller (200)', async () => {
    // Same Subscription body under both codes, so a portal that grants starter
    // credits on "activated" would otherwise grant them on every page load.
    const created = vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data: SUBSCRIPTION }));
    const existing = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: SUBSCRIPTION }));

    await expect(makeClient(created).subscribe(TOKEN)).resolves.toEqual({
      subscription: SUBSCRIPTION,
      activated: true,
    });
    await expect(makeClient(existing).subscribe(TOKEN)).resolves.toMatchObject({ activated: false });
  });

  it('names the beneficiary organization when one is given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(201, { success: true, data: SUBSCRIPTION }));

    await makeClient(fetchSpy).subscribe(TOKEN, { organizationId: 'org_7' });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ organizationId: 'org_7' });
  });

  it('refuses without a publishable key rather than calling the API', async () => {
    const fetchSpy = vi.fn();
    const client = new RekeyBrowserClient({ apiUrl: 'https://api.example.com', fetch: fetchSpy });

    await expect(client.subscribe(TOKEN)).rejects.toMatchObject({
      code: 'CONFIG_MISSING_PUBLISHABLE_KEY',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('getTrialEligibility', () => {
  const BODY = {
    items: [{ planSlug: 'pro', trialDays: 14, eligible: true, reason: null, redeemedAt: null, endsAt: null }],
    page: { total: 1, limit: 50, offset: 0, hasMore: false },
    policy: 'once_per_application',
    provider: 'stripe',
  };

  it('returns items, policy and provider for the signed-in buyer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: BODY }));

    const result = await makeClient(fetchSpy).getTrialEligibility(TOKEN);

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/billing/trial-eligibility');
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(TOKEN);
    expect(result.items[0]!.trialDays).toBe(14);
    expect(result.provider).toBe('stripe');
  });

  it('narrows to one plan and to an organization', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: BODY }));

    await makeClient(fetchSpy).getTrialEligibility(TOKEN, { planSlug: 'pro', organizationId: 'org_7' });

    const query = new URL(fetchSpy.mock.calls[0]![0] as string).searchParams;
    expect(query.get('planSlug')).toBe('pro');
    expect(query.get('organizationId')).toBe('org_7');
  });
});

describe('listMyDevices / releaseMyDevice', () => {
  const DEVICE = {
    id: 'dev_1',
    applicationId: 'app_1',
    endUserId: 'eu_1',
    fingerprint: 'fp',
    label: 'Work laptop',
    status: 'ACTIVE',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-02-01T00:00:00.000Z',
    releasedAt: null,
    blockedAt: null,
    metadata: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };

  it('lists the signed-in user own devices', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { items: [DEVICE], page: { total: 1, limit: 50, offset: 0, hasMore: false } },
      }),
    );

    const page = await makeClient(fetchSpy).listMyDevices(TOKEN);

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/users/me/devices/');
    expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe(TOKEN);
    expect(page.items[0]!.label).toBe('Work laptop');
  });

  it('filters by status', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { items: [], page: { total: 0, limit: 50, offset: 0, hasMore: false } },
      }),
    );

    await makeClient(fetchSpy).listMyDevices(TOKEN, { status: 'ACTIVE' });

    expect(new URL(fetchSpy.mock.calls[0]![0] as string).searchParams.get('status')).toBe('ACTIVE');
  });

  it('releases a device, the flow DEVICE_LIMIT_REACHED tells clients to offer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { success: true, data: { device: DEVICE, sessionsRevoked: 1 } }),
    );

    const result = await makeClient(fetchSpy).releaseMyDevice(TOKEN, 'dev_1');

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/users/me/devices/dev_1');
    expect(init.method).toBe('DELETE');
    expect(result.sessionsRevoked).toBe(1);
  });

  it('surfaces DEVICE_BLOCKED as a typed error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        success: false,
        error: { code: 'DEVICE_BLOCKED', message: 'Blocked.', fix: 'An operator must unblock it.' },
      }),
    );

    const err = await makeClient(fetchSpy)
      .releaseMyDevice(TOKEN, 'dev_1')
      .catch((e) => e as RekeyError);

    expect(err).toBeInstanceOf(RekeyError);
    expect(err.code).toBe('DEVICE_BLOCKED');
  });
});
