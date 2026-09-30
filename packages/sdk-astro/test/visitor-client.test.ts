/**
 * `visitorClient` forwards the visitor's address and User-Agent, so the API
 * rate-limits the visitor rather than this server and the session records the
 * visitor's browser rather than this server's runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visitorClient } from '../src/index.js';

function ok(): Response {
  return new Response(JSON.stringify({ success: true, data: { mfaRequired: false } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('visitorClient', () => {
  const fetchImpl = vi.fn();

  beforeEach(() => {
    process.env.REKEY_SECRET = 'rp_test_visitor';
    process.env.REKEY_URL = 'https://api.test.invalid';
    fetchImpl.mockReset().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchImpl);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sent(): Headers {
    return new Headers((fetchImpl.mock.calls[0]![1] as RequestInit).headers as HeadersInit);
  }

  it('sends the visitor address and User-Agent', async () => {
    const request = new Request('https://app.example/api/sign-in', {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' },
    });
    await visitorClient({ request, clientAddress: '203.0.113.9' }).auth.signIn({ email: 'a@b.co', password: 'pw' });
    expect(sent().get('x-rekey-client-ip')).toBe('203.0.113.9');
    expect(sent().get('x-rekey-client-user-agent')).toBe('Mozilla/5.0 (iPhone) Safari/604.1');
  });

  it('sends neither when Astro has no address and the request no User-Agent', async () => {
    const request = new Request('https://app.example/api/sign-in');
    const context = {
      request,
      get clientAddress(): string {
        throw new Error('clientAddress is not available');
      },
    };
    await visitorClient(context).auth.signIn({ email: 'a@b.co', password: 'pw' });
    expect(sent().has('x-rekey-client-ip')).toBe(false);
    expect(sent().has('x-rekey-client-user-agent')).toBe(false);
  });
});
