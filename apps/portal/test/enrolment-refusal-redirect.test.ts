/**
 * A call the API refuses with MFA_ENROLLMENT_REQUIRED sends the customer to
 * the two-factor set-up page, whether it went through the portal's own
 * customer call or the SDK client the billing pages use.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
const config = {
  slug: 'acme',
  name: 'Acme',
  publishableKey: 'rp_pub_test',
  billingSubject: 'user',
  billingEnabled: true,
  branding: {},
  auth: { mfaRequired: true },
};
vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => config,
  PortalConfigUnavailableError: class extends Error {},
}));
vi.mock('@/lib/env', () => ({
  portalBaseUrl: () => 'https://portal.example',
  rekeyApiUrl: () => 'https://api.example',
}));
vi.mock('@/lib/client-ip', () => ({
  API_TIMEOUT_MS: 1000,
  forwardedClientHeaders: async () => ({}),
  publishableKeyCallHeaders: async () => ({}),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { customerCall } = await import('@/lib/customer-call');
const { portalClientFor } = await import('@/lib/session');

function answer(status: number, code: string) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify({ success: false, error: { code, message: 'no' } }), { status }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('a call refused for missing two-factor enrolment', () => {
  it('redirects from the customer call', async () => {
    answer(403, 'MFA_ENROLLMENT_REQUIRED');
    await expect(customerCall(config as never, 'at', 'GET', '/api/v1/users/me/devices')).rejects.toThrow(
      'REDIRECT /acme/two-factor/set-up',
    );
  });

  it('redirects from an SDK billing read', async () => {
    answer(403, 'MFA_ENROLLMENT_REQUIRED');
    const client = await portalClientFor('acme');
    await expect(client!.getSubscription('at')).rejects.toThrow('REDIRECT /acme/two-factor/set-up');
  });

  it('leaves any other refusal to the caller', async () => {
    answer(403, 'ORIGIN_NOT_ALLOWED');
    expect(await customerCall(config as never, 'at', 'GET', '/api/v1/users/me/devices')).toEqual({
      ok: false,
      code: 'ORIGIN_NOT_ALLOWED',
    });
  });
});
