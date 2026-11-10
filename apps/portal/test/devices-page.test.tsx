/**
 * The devices page: a customer whose desktop app says "device limit reached"
 * sees the devices holding their slots, removes one, and is told they can sign
 * in on the new computer.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  signedIn: true,
  billingEnabled: true,
  branding: { displayName: 'Acme Desktop' } as Record<string, string>,
};

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'rekey_portal_access' ? { name, value: 'at' } : undefined) }),
  headers: async () => new Headers({ 'accept-language': 'en-IN,en;q=0.9' }),
}));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getPortalConfig: async () => ({
    name: 'Acme',
    publishableKey: 'pk_test',
    billingEnabled: state.billingEnabled,
    billingSubject: 'user',
    branding: state.branding,
    auth: { devices: true },
  }),
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
vi.mock('@/lib/two-factor', () => ({
  redirectWhileTwoFactorOutstanding: async () => undefined,
}));
vi.mock('@/lib/profile-completion', () => ({ redirectWhileProfileOutstanding: async () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT FOUND');
  },
}));
const client = { getPlans: vi.fn(async () => ({ items: [{ id: 'p_pro' }] })) };
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  getPortalUser: async () => (state.signedIn ? { accessToken: 'at', user: { email: 'a@example.com' } } : null),
  portalClientFor: async () => client,
}));

const { default: DevicesPage } = await import('@/app/(portal)/[slug]/devices/page');
const { removeDeviceAction } = await import('@/lib/actions');

const LAPTOP = { id: 'dev_laptop', label: 'Work laptop', lastSeenAt: '2026-11-03T22:30:00.000Z', status: 'ACTIVE' };
const UNNAMED = { id: 'dev_unnamed', label: null, lastSeenAt: '2026-10-01T09:00:00.000Z', status: 'ACTIVE' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

type Answers = { active?: unknown[]; released?: unknown[]; maxDevices?: unknown; remove?: () => Response };

/** The API by route: the device lists by status, the entitlements and the release. */
function api({ active = [], released = [], maxDevices, remove }: Answers = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/users/me/devices' && init?.method === 'GET') {
      const items = url.searchParams.get('status') === 'RELEASED' ? released : active;
      return json(200, { success: true, data: { items, page: { total: items.length } } });
    }
    if (url.pathname === '/api/v1/billing/entitlements') {
      const features = maxDevices === undefined ? {} : { max_devices: maxDevices };
      return json(200, { success: true, data: { features, entitlements: [] } });
    }
    if (url.pathname.startsWith('/api/v1/users/me/devices/') && init?.method === 'DELETE' && remove) return remove();
    throw new Error(`unexpected call to ${init?.method} ${url.pathname}`);
  });
}

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await DevicesPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const m = /^REDIRECT (.*)$/.exec((err as Error).message);
    if (m) return m[1]!;
    throw err;
  }
  throw new Error('no redirect');
}

beforeEach(() => {
  state.signedIn = true;
  state.billingEnabled = true;
  state.branding = { displayName: 'Acme Desktop' };
});
afterEach(() => vi.restoreAllMocks());

describe('the devices list', () => {
  it('lists each active device with its last use, under one heading, and names an unlabelled one', async () => {
    api({ active: [LAPTOP, UNNAMED] });
    const html = await render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('Work laptop · Last used 3 Nov 2026');
    expect(html).toContain('Unnamed device · Last used 1 Oct 2026');
    expect(html).toContain('>Remove<');
    expect(html).toContain('Remove Work laptop?');
    expect(html).toContain(
      'Work laptop will be signed out of Acme Desktop and will stop counting toward your limit. You can sign in on it again later if you have a free spot.',
    );
    expect(html).toMatch(/<dialog[^>]*aria-describedby="([^"]+)"[\s\S]*id="\1"/);
  });

  it('says no devices are in use when there are none', async () => {
    api();
    expect(await render()).toContain(
      'No devices are using Acme Desktop right now. Devices appear here after you sign in to the app on them.',
    );
  });

  it('sends a signed-out visitor to sign-in, asking to come back here', async () => {
    state.signedIn = false;
    expect(await redirectOf(() => render())).toBe('/acme/login?return=devices');
  });
});

describe('the device limit', () => {
  it('at the limit, explains what to do and points to the plans without claiming any has a higher limit', async () => {
    api({ active: [LAPTOP, UNNAMED], maxDevices: 2 });
    const html = await render();
    expect(html).toContain(
      'Your plan lets you use Acme Desktop on 2 devices, and every one is in use. To use Acme Desktop on a new computer, remove one you no longer use, then sign in on the new one.',
    );
    expect(html).toContain('Need more devices?');
    expect(html).toContain('href="/acme#plans"');
    expect(html).toContain('>See plans</a>.');
    expect(html).not.toContain('higher limit');
  });

  it('at a limit of one, says the one device is in use', async () => {
    api({ active: [LAPTOP], maxDevices: 1 });
    expect(await render()).toContain('Your plan lets you use Acme Desktop on 1 device, and it is in use.');
  });

  it('at the limit with no plans listed, offers no plans link', async () => {
    client.getPlans.mockResolvedValueOnce({ items: [] });
    api({ active: [LAPTOP, UNNAMED], maxDevices: 2 });
    const html = await render();
    expect(html).not.toContain('Need more devices?');
    expect(html).not.toContain('#plans');
  });

  it('below the limit, counts the devices in use and offers no plans', async () => {
    api({ active: [LAPTOP], maxDevices: '3' });
    const html = await render();
    expect(html).toContain('1 of 3 devices in use.');
    expect(html).not.toContain('Need more devices?');
  });

  it('says nothing about a limit when the plan sets none', async () => {
    api({ active: [LAPTOP] });
    const html = await render();
    expect(html).not.toContain('in use');
  });
});

describe('removing a device', () => {
  it('releases it through the API with the customer token and says the new device can sign in', async () => {
    const fetchSpy = api({
      remove: () => json(200, { success: true, data: { device: { ...LAPTOP, status: 'RELEASED' }, sessionsRevoked: 1 } }),
    });
    expect(await redirectOf(() => removeDeviceAction('acme', 'dev_laptop'))).toBe('/acme/devices?removed=dev_laptop');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example/api/v1/users/me/devices/dev_laptop');
    expect(init!.method).toBe('DELETE');
    expect(new Headers(init!.headers).get('X-Rekey-User-Token')).toBe('at');

    vi.restoreAllMocks();
    api({ active: [UNNAMED], released: [{ ...LAPTOP, status: 'RELEASED' }] });
    expect(await render({ removed: 'dev_laptop' })).toContain(
      'Work laptop was removed. You can now sign in to Acme Desktop on your new device.',
    );
  });

  it('claims no removal for a device the customer does not have', async () => {
    api({ active: [LAPTOP], released: [] });
    expect(await render({ removed: 'dev_someone_else' })).not.toContain('was removed');
  });

  it('says why a removal failed', async () => {
    api({ remove: () => json(409, { error: { code: 'DEVICE_BLOCKED' } }) });
    expect(await redirectOf(() => removeDeviceAction('acme', 'dev_laptop'))).toBe('/acme/devices?error=DEVICE_BLOCKED');
    vi.restoreAllMocks();
    api({ active: [LAPTOP] });
    const html = await render({ error: 'DEVICE_BLOCKED' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('That device is blocked, so it cannot be removed here.');
  });

  it('when the application keeps removal with support, still lists the devices but offers support instead of Remove', async () => {
    state.branding = { displayName: 'Acme Desktop', supportEmail: 'help@acme.test' };
    api({ remove: () => json(403, { error: { code: 'DEVICE_SELF_RELEASE_DISABLED' } }) });
    const to = await redirectOf(() => removeDeviceAction('acme', 'dev_laptop'));
    expect(to).toBe('/acme/devices?error=DEVICE_SELF_RELEASE_DISABLED');
    vi.restoreAllMocks();
    api({ active: [LAPTOP] });
    const html = await render({ error: 'DEVICE_SELF_RELEASE_DISABLED' });
    expect(html).toContain('Work laptop · Last used');
    expect(html).not.toContain('>Remove<');
    expect(html).toContain('To remove a device, contact <a href="mailto:help@acme.test" class="underline">Acme Desktop support</a> and tell them which one.');
  });
});
