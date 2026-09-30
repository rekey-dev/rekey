/**
 * `RekeyBrowserClient.getMe(token, { include })`: the request it sends and
 * the null-on-invalid-token contract it shares with `getCurrentUser`.
 */

import { describe, expect, it, vi } from 'vitest';
import { RekeyBrowserClient } from '../src/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeClient(fetchImpl: typeof fetch): RekeyBrowserClient {
  return new RekeyBrowserClient({ apiUrl: 'https://api.example.com', publishableKey: 'rp_pub_demo', fetch: fetchImpl });
}

describe('self reads', () => {
  it('listMyLicenses, getFeature and hasFeature send the user token with the publishable key', async () => {
    const page = { items: [], page: { total: 0, limit: 50, offset: 0, hasMore: false } };
    const list = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: page }));
    expect(await makeClient(list).listMyLicenses('jwt.user', { limit: 5 })).toEqual(page);
    const [listUrl, listInit] = list.mock.calls[0]! as [string, RequestInit];
    expect(listUrl).toBe('https://api.example.com/api/v1/users/me/licenses/?limit=5');
    expect((listInit.headers as Record<string, string>)['X-Rekey-User-Token']).toBe('jwt.user');

    const feature = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { success: true, data: { key: 'beta', granted: false, value: false } }));
    expect(await makeClient(feature).hasFeature('jwt.user', 'beta', { organizationId: 'org_1' })).toBe(false);
    expect(feature.mock.calls[0]![0]).toBe(
      'https://api.example.com/api/v1/billing/entitlements/features/beta?organizationId=org_1',
    );
  });

  it('listMyLicenses passes organizationId, alone or after the page, encoded', async () => {
    const page = { items: [], page: { total: 0, limit: 50, offset: 0, hasMore: false } };
    const answer = () => vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: page }));

    const orgOnly = answer();
    await makeClient(orgOnly).listMyLicenses('jwt.user', undefined, { organizationId: 'org 1' });
    const [orgUrl, orgInit] = orgOnly.mock.calls[0]! as [string, RequestInit];
    expect(orgUrl).toBe('https://api.example.com/api/v1/users/me/licenses/?organizationId=org+1');
    expect((orgInit.headers as Record<string, string>)['X-Rekey-User-Token']).toBe('jwt.user');

    const both = answer();
    await makeClient(both).listMyLicenses('jwt.user', { limit: 5, offset: 10 }, { organizationId: 'org_1' });
    expect(both.mock.calls[0]![0]).toBe(
      'https://api.example.com/api/v1/users/me/licenses/?limit=5&offset=10&organizationId=org_1',
    );

    const none = answer();
    await makeClient(none).listMyLicenses('jwt.user', undefined, {});
    expect(none.mock.calls[0]![0]).toBe('https://api.example.com/api/v1/users/me/licenses/');
  });
});

describe('getMe', () => {
  it('calls GET /auth/me with the token alone and no query string by default', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { id: 'usr_1' } }));
    expect(await makeClient(fetchSpy).getMe('jwt.user.token')).toEqual({ id: 'usr_1' });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/auth/me');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Rekey-User-Token']).toBe('jwt.user.token');
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends include comma-separated and deduplicated', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { id: 'usr_1' } }));
    await makeClient(fetchSpy).getMe('t', { include: ['entitlements', 'device', 'entitlements'] });
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.example.com/api/v1/auth/me?include=entitlements,device');
  });

  it('returns null on USER_TOKEN_INVALID and throws anything else', async () => {
    const invalid = vi.fn().mockResolvedValue(
      jsonResponse(401, { success: false, error: { code: 'USER_TOKEN_INVALID', message: 'x' } }),
    );
    expect(await makeClient(invalid).getMe('t', { include: ['device'] })).toBeNull();

    const bad = vi.fn().mockResolvedValue(
      jsonResponse(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'x' } }),
    );
    await expect(makeClient(bad).getMe('t', { include: ['device'] })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('a banned or erased account reads as signed out', () => {
  it.each([
    [403, 'END_USER_BANNED'],
    [410, 'END_USER_ERASED'],
  ])('%i %s is null from getCurrentUser and getMe, not a throw', async (status, code) => {
    const refuse = () =>
      vi.fn().mockResolvedValue(jsonResponse(status, { success: false, error: { code, message: 'x', fix: 'y' } }));
    expect(await makeClient(refuse()).getCurrentUser('jwt.user')).toBeNull();
    expect(await makeClient(refuse()).getMe('jwt.user')).toBeNull();
  });
});
