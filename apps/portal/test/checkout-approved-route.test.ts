/**
 * The portal's `approved` route: the one POST the checkout page makes. It is
 * refused before reaching the API unless it comes from this portal's own
 * origin, as JSON, with a well-formed subscription id.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirm = vi.fn(async () => ({ status: 200, body: { status: 'confirming' } }));
vi.mock('@/lib/checkout-api', () => ({ confirmApproval: (...args: unknown[]) => confirm(...(args as [])) }));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example' }));

const { POST } = await import('@/app/(checkout)/[slug]/checkout/[token]/approved/route');

const TOKEN = `chk_test_${'E'.repeat(43)}`;
const params = { params: Promise.resolve({ slug: 'acme', token: TOKEN }) };

function request(headers: Record<string, string>, body: unknown): Request {
  return new Request(`https://portal.example/acme/checkout/${TOKEN}/approved`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST …/approved', () => {
  beforeEach(() => confirm.mockClear());

  it('forwards a same-origin JSON approval', async () => {
    const res = await POST(request({ origin: 'https://portal.example', 'content-type': 'application/json' }, { subscriptionId: 'I-ABC123' }), params);
    expect(res.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith(TOKEN, 'I-ABC123');
  });

  it('refuses another origin, a missing origin, a form post and a malformed id without calling the API', async () => {
    const cases = [
      request({ origin: 'https://evil.example', 'content-type': 'application/json' }, { subscriptionId: 'I-ABC123' }),
      request({ 'content-type': 'application/json' }, { subscriptionId: 'I-ABC123' }),
      request({ origin: 'https://portal.example', 'content-type': 'application/x-www-form-urlencoded' }, 'subscriptionId=I-ABC123'),
      request({ origin: 'https://portal.example', 'content-type': 'application/json' }, { subscriptionId: '../../oauth' }),
    ];
    const statuses = [];
    for (const req of cases) statuses.push((await POST(req, params)).status);
    expect(statuses).toEqual([403, 403, 415, 400]);
    expect(confirm).not.toHaveBeenCalled();
  });
});
