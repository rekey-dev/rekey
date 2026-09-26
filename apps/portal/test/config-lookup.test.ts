/**
 * A failed portal config lookup is one typed error, whatever the failure was.
 *
 * The refresh route and the render both run this lookup before any refresh,
 * and both answer a failed lookup with the 503 retry page instead of a bare
 * 500. They can only do that if every failure but a 404 arrives as
 * `PortalConfigUnavailableError`, including a connection that was refused
 * before any status existed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/env', () => ({ rekeyApiUrl: () => 'https://api.test' }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function refused(): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3030'), { code: 'ECONNREFUSED' }),
  });
}

describe('getPortalConfig', () => {
  it('a refused connection is PortalConfigUnavailableError, not a raw fetch error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw refused();
    });
    const { getPortalConfig, PortalConfigUnavailableError } = await import('@/lib/config');

    const err = await getPortalConfig('acme').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PortalConfigUnavailableError);
    expect((err as InstanceType<typeof PortalConfigUnavailableError>).retryAfterSeconds).toBe(5);
  });

  it.each([502, 503, 504, 500])('an HTTP %i is PortalConfigUnavailableError carrying Retry-After', async (status) => {
    vi.stubGlobal('fetch', async () => new Response('<html>down</html>', { status, headers: { 'retry-after': '7' } }));
    const { getPortalConfig, PortalConfigUnavailableError } = await import('@/lib/config');

    const err = await getPortalConfig('acme').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PortalConfigUnavailableError);
    expect((err as InstanceType<typeof PortalConfigUnavailableError>).retryAfterSeconds).toBe(7);
  });

  it('a 200 that is not the envelope is PortalConfigUnavailableError', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>captive portal</html>', { status: 200 }));
    const { getPortalConfig, PortalConfigUnavailableError } = await import('@/lib/config');

    await expect(getPortalConfig('acme')).rejects.toBeInstanceOf(PortalConfigUnavailableError);
  });

  it('a 404 is still null: the app does not exist', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    const { getPortalConfig } = await import('@/lib/config');

    await expect(getPortalConfig('acme')).resolves.toBeNull();
  });
});

describe('retryAfterFrom', () => {
  it('reads whole seconds and falls back to 5 for anything else', async () => {
    const { retryAfterFrom } = await import('@/lib/config');

    expect(retryAfterFrom('30')).toBe(30);
    expect(retryAfterFrom('0')).toBe(1);
    expect(retryAfterFrom(null)).toBe(5);
    expect(retryAfterFrom('Wed, 21 Oct 2015 07:28:00 GMT')).toBe(5);
  });
});
