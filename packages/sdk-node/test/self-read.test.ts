/**
 * The self-read helpers: `licenses.listMine`, `billing.getFeature` /
 * `hasFeature` and their for-user variants. What each request looks like on
 * the wire; the API's own tests cover what it answers.
 */

import { describe, expect, it, vi } from 'vitest';
import { Rekey } from '../src/index.js';

function client(fetchImpl: typeof fetch): Rekey {
  return new Rekey({ apiUrl: 'https://api.example.com', secretKey: 'rp_live_token', fetch: fetchImpl });
}

const answer = (data: unknown) =>
  vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

function sent(fetchSpy: ReturnType<typeof vi.fn>): { url: string; token: string | undefined } {
  const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
  return { url, token: (init.headers as Record<string, string>)['X-Rekey-User-Token'] };
}

describe('licenses.listMine', () => {
  it('reads /users/me/licenses with the user token, paging when asked', async () => {
    const page = { items: [], page: { total: 0, limit: 50, offset: 0, hasMore: false } };
    const plain = answer(page);
    expect(await client(plain).licenses.listMine('jwt.user')).toEqual(page);
    expect(sent(plain)).toEqual({ url: 'https://api.example.com/api/v1/users/me/licenses/', token: 'jwt.user' });

    const paged = answer(page);
    await client(paged).licenses.listMine('jwt.user', { limit: 10, offset: 20 });
    expect(sent(paged).url).toBe('https://api.example.com/api/v1/users/me/licenses/?limit=10&offset=20');
  });
});

describe('billing feature checks', () => {
  it('getFeature and hasFeature call the token route, encoding the key', async () => {
    const spy = answer({ key: 'a/b', granted: true, value: 3 });
    expect(await client(spy).billing.getFeature('jwt.user', 'a/b', { organizationId: 'org 1' })).toEqual({
      key: 'a/b',
      granted: true,
      value: 3,
    });
    expect(sent(spy)).toEqual({
      url: 'https://api.example.com/api/v1/billing/entitlements/features/a%2Fb?organizationId=org%201',
      token: 'jwt.user',
    });

    expect(await client(answer({ key: 'x', granted: false, value: 0 })).billing.hasFeature('jwt.user', 'x')).toBe(false);
    expect(await client(answer({ key: 'x', granted: true, value: true })).billing.hasFeature('jwt.user', 'x')).toBe(true);
  });

  it('getFeatureFor and hasFeatureFor name the end-user and send no user token', async () => {
    const spy = answer({ key: 'reports', granted: true, value: true });
    expect(await client(spy).billing.hasFeatureFor('eu_1', 'reports')).toBe(true);
    expect(sent(spy)).toEqual({
      url: 'https://api.example.com/api/v1/billing/entitlements/for-user/features/reports?endUserId=eu_1',
      token: undefined,
    });
    const withOrg = answer({ key: 'reports', granted: false, value: null });
    await client(withOrg).billing.getFeatureFor('eu_1', 'reports', { organizationId: 'org_1' });
    expect(sent(withOrg).url).toBe(
      'https://api.example.com/api/v1/billing/entitlements/for-user/features/reports?endUserId=eu_1&organizationId=org_1',
    );
  });
});
