/**
 * `auth.getCurrentUser(token, { include })`: the query string it sends. The
 * API's own tests cover what each value returns.
 */

import { describe, expect, it, vi } from 'vitest';
import { Rekey } from '../src/index.js';

function client(fetchImpl: typeof fetch): Rekey {
  return new Rekey({ apiUrl: 'https://api.example.com', secretKey: 'rp_live_token', fetch: fetchImpl });
}

const ok = () =>
  new Response(JSON.stringify({ success: true, data: { id: 'usr_1' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

async function urlFor(options?: Parameters<Rekey['auth']['getCurrentUser']>[1]): Promise<string> {
  const fetchSpy = vi.fn().mockResolvedValue(ok());
  await client(fetchSpy).auth.getCurrentUser('jwt.user.token', options);
  const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
  expect((init.headers as Record<string, string>)['X-Rekey-User-Token']).toBe('jwt.user.token');
  return url;
}

describe('auth.getCurrentUser include', () => {
  it('sends no query string without include, or with an empty one', async () => {
    expect(await urlFor()).toBe('https://api.example.com/api/v1/users/me/');
    expect(await urlFor({})).toBe('https://api.example.com/api/v1/users/me/');
    expect(await urlFor({ include: [] })).toBe('https://api.example.com/api/v1/users/me/');
  });

  it('sends the values comma-separated, once each, in the order given', async () => {
    expect(await urlFor({ include: ['entitlements', 'device'] })).toBe(
      'https://api.example.com/api/v1/users/me/?include=entitlements,device',
    );
    expect(await urlFor({ include: ['device', 'device', 'organization', 'subscription'] })).toBe(
      'https://api.example.com/api/v1/users/me/?include=device,organization,subscription',
    );
  });
});
