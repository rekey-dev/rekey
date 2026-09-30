/** `rekey.users.updateProfile`: the secret-key profile write. */

import { describe, expect, it, vi } from 'vitest';
import { Rekey } from '../src/index.js';

describe('users.updateProfile', () => {
  it('PATCHes the answers to /users/:id/profile and returns the stored state', async () => {
    const state = { profile: { plan_tier: 'enterprise' }, onboardingCompletedAt: null };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: state }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const rekey = new Rekey({ apiUrl: 'https://api.test', secretKey: 'rp_test_x', fetch: fetchImpl });
    const result = await rekey.users.updateProfile('eu 1', { plan_tier: 'enterprise', company: null });
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/api/v1/users/eu%201/profile');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ plan_tier: 'enterprise', company: null });
    expect(result).toEqual(state);
  });
});

describe.each([
  ['completeOnboarding', 'complete', 'completed'],
  ['skipOnboarding', 'skip', 'skipped'],
] as const)('users.%s', (method, segment, status) => {
  it(`POSTs to /users/:id/onboarding/${segment} with no body and returns the state`, async () => {
    const state = {
      profile: {},
      onboardingCompletedAt: status === 'completed' ? '2026-09-30T10:00:00.000Z' : null,
      onboardingSkippedAt: status === 'skipped' ? '2026-09-30T10:00:00.000Z' : null,
      onboardingStatus: status,
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: state }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const rekey = new Rekey({ apiUrl: 'https://api.test', secretKey: 'rp_test_x', fetch: fetchImpl });
    const result = await rekey.users[method]('eu 1');
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://api.test/api/v1/users/eu%201/onboarding/${segment}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(result).toEqual(state);
  });
});
