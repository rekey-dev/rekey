/**
 * `clientIp`: the visitor's address, forwarded to the API as
 * `X-Rekey-Client-Ip` so per-IP sign-in limits count the visitor rather than
 * the server making the call.
 */

import { describe, expect, it, vi } from 'vitest';
import { CLIENT_IP_HEADER, Rekey, normalizeClientIp } from '../src/index.js';

function ok(): Response {
  return new Response(JSON.stringify({ success: true, data: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sentHeaders(fetchImpl: ReturnType<typeof vi.fn>): Headers {
  const init = fetchImpl.mock.calls[0]![1] as RequestInit;
  return new Headers(init.headers as HeadersInit);
}

describe('clientIp', () => {
  it('is the exact header name the API reads', () => {
    expect(CLIENT_IP_HEADER.toLowerCase()).toBe('x-rekey-client-ip');
  });

  it('with({ clientIp }) sends it on a sign-in', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const rekey = new Rekey({ apiUrl: 'https://api.test', secretKey: 'rp_test_x', fetch: fetchImpl });
    await rekey.with({ clientIp: '203.0.113.9' }).auth.signIn({ email: 'a@b.co', password: 'pw' });
    expect(sentHeaders(fetchImpl).get(CLIENT_IP_HEADER)).toBe('203.0.113.9');
  });

  it('is not sent when not configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const rekey = new Rekey({ apiUrl: 'https://api.test', secretKey: 'rp_test_x', fetch: fetchImpl });
    await rekey.auth.signIn({ email: 'a@b.co', password: 'pw' });
    expect(sentHeaders(fetchImpl).has(CLIENT_IP_HEADER)).toBe(false);
  });

  it('refuses a list rather than forwarding it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const rekey = new Rekey({
      apiUrl: 'https://api.test',
      secretKey: 'rp_test_x',
      fetch: fetchImpl,
      clientIp: '198.51.100.1, 203.0.113.9',
    });
    await rekey.auth.signIn({ email: 'a@b.co', password: 'pw' });
    expect(sentHeaders(fetchImpl).has(CLIENT_IP_HEADER)).toBe(false);
  });

  it.each([
    ['203.0.113.9', '203.0.113.9'],
    [' 2001:db8::1 ', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['::ffff:203.0.113.9', '::ffff:203.0.113.9'],
    ['256.1.1.1', null],
    ['203.0.113.9:443', null],
    ['a, b', null],
    ['', null],
    ['evil.example', null],
  ])('normalizeClientIp(%j) is %j', (input, expected) => {
    expect(normalizeClientIp(input)).toBe(expected);
  });
});
