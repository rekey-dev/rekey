/**
 * `clientIp`: the visitor's address, forwarded to the API as
 * `X-Rekey-Client-Ip` so per-IP sign-in limits count the visitor rather than
 * the server making the call.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_IP_HEADER,
  CLIENT_USER_AGENT_HEADER,
  Rekey,
  VISITOR_COUNTRY_HINT_HEADER,
  normalizeClientIp,
  normalizeCountryHint,
  visitorCountryHintFrom,
} from '../src/index.js';

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

describe('clientUserAgent', () => {
  it('is the exact header name the API reads', () => {
    expect(CLIENT_USER_AGENT_HEADER.toLowerCase()).toBe('x-rekey-client-user-agent');
  });

  it('with({ clientUserAgent }) sends it beside the address', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const rekey = new Rekey({ apiUrl: 'https://api.test', secretKey: 'rp_test_x', fetch: fetchImpl });
    await rekey
      .with({ clientIp: '203.0.113.9', clientUserAgent: 'Mozilla/5.0 (iPhone) Safari/604.1' })
      .auth.signIn({ email: 'a@b.co', password: 'pw' });
    const sent = sentHeaders(fetchImpl);
    expect(sent.get(CLIENT_USER_AGENT_HEADER)).toBe('Mozilla/5.0 (iPhone) Safari/604.1');
    expect(sent.get(CLIENT_IP_HEADER)).toBe('203.0.113.9');
  });

  it('is not sent when not configured or blank', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const rekey = new Rekey({ apiUrl: 'https://api.test', secretKey: 'rp_test_x', fetch: fetchImpl });
    await rekey.with({ clientUserAgent: '   ' }).auth.signIn({ email: 'a@b.co', password: 'pw' });
    expect(sentHeaders(fetchImpl).has(CLIENT_USER_AGENT_HEADER)).toBe(false);
  });
});

describe('visitorCountryHint', () => {
  const client = (fetchImpl: ReturnType<typeof vi.fn>, config: { visitorCountryHint?: string } = {}): Rekey =>
    new Rekey({ apiUrl: 'https://api.test', secretKey: 'rp_test_x', fetch: fetchImpl, ...config });

  it('is the exact header name the API reads', () => {
    expect(VISITOR_COUNTRY_HINT_HEADER.toLowerCase()).toBe('x-rekey-visitor-country-hint');
  });

  it('with({ visitorCountryHint }) sends it on a checkout, and never as the declared country', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await client(fetchImpl)
      .with({ visitorCountryHint: 'in' })
      .billing.createCheckout('user.jwt', { planSlug: 'pro', successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/no' });
    const headers = sentHeaders(fetchImpl);
    expect(headers.get(VISITOR_COUNTRY_HINT_HEADER)).toBe('IN');
    expect(headers.has('x-country')).toBe(false);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect('country' in body).toBe(false);
  });

  it('survives a later with(), and is not sent when not configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await client(fetchImpl, { visitorCountryHint: 'DE' }).with({ clientIp: '203.0.113.9' }).billing.getProviders();
    expect(sentHeaders(fetchImpl).get(VISITOR_COUNTRY_HINT_HEADER)).toBe('DE');

    const bare = vi.fn().mockResolvedValue(ok());
    await client(bare).billing.getProviders();
    expect(sentHeaders(bare).has(VISITOR_COUNTRY_HINT_HEADER)).toBe(false);
  });

  it.each(['XX', 'xx', 'T1', 'IND', 'I', '', 'I N', '1N'])('does not send %j, which is not a country', async (bad) => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await client(fetchImpl, { visitorCountryHint: bad }).billing.getProviders();
    expect(sentHeaders(fetchImpl).has(VISITOR_COUNTRY_HINT_HEADER)).toBe(false);
    expect(normalizeCountryHint(bad)).toBeNull();
  });

  it('visitorCountryHintFrom reads Cloudflare, then Vercel, and nothing else', () => {
    expect(visitorCountryHintFrom(new Headers({ 'cf-ipcountry': 'in', 'x-vercel-ip-country': 'US' }))).toBe('IN');
    expect(visitorCountryHintFrom(new Headers({ 'cf-ipcountry': 'XX', 'x-vercel-ip-country': 'us' }))).toBe('US');
    expect(visitorCountryHintFrom(new Headers({ 'x-country': 'IN' }))).toBeUndefined();
  });
});
