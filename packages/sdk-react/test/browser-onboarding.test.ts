/**
 * `RekeyBrowserClient.completeOnboarding` and `skipOnboarding`: the
 * publishable key plus the user's own token, a bodiless POST, and the
 * onboarding state handed back as the API returned it.
 */

import { describe, expect, it, vi } from 'vitest';
import { RekeyBrowserClient } from '../src/client.js';

const TOKEN = 'jwt.user.token';

describe.each([
  ['completeOnboarding', 'complete', 'completed'],
  ['skipOnboarding', 'skip', 'skipped'],
] as const)('%s', (method, segment, status) => {
  it(`POSTs /users/me/onboarding/${segment} with the publishable key and the user token`, async () => {
    const state = {
      profile: {},
      onboardingCompletedAt: status === 'completed' ? '2026-09-30T10:00:00.000Z' : null,
      onboardingSkippedAt: status === 'skipped' ? '2026-09-30T10:00:00.000Z' : null,
      onboardingStatus: status,
    };
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: state }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new RekeyBrowserClient({
      apiUrl: 'https://api.example.com',
      publishableKey: 'rp_pub_demo',
      fetch: fetchSpy,
    });

    await expect(client[method](TOKEN)).resolves.toEqual(state);

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://api.example.com/api/v1/users/me/onboarding/${segment}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer rp_pub_demo');
    expect(headers['X-Rekey-User-Token']).toBe(TOKEN);
  });
});
