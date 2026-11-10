/**
 * On a custom domain the portal's cookies cover `/`, the links it asks the API
 * to email or return to sit on that domain with no slug, and publishable-key
 * calls carry that domain's origin. On the shared host, all three are as they
 * were. The domain comes only from the header the middleware sets.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestHeaders = new Headers();
type Cookie = { value: string; options: Record<string, unknown> };
const jar = new Map<string, Cookie>();

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => jar.set(name, { value, options }),
  }),
}));

const posted: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
  posted.push({ url, body: JSON.parse(String(init.body ?? '{}')), headers: new Headers(init.headers) });
  return Response.json({ success: true, data: {} });
});

vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => ({ publishableKey: 'pk_test', billingSubject: 'user', auth: {} }),
  PortalConfigUnavailableError: class extends Error {},
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

process.env.PORTAL_BASE_URL = 'https://portal.example';
process.env.REKEY_URL = 'https://api.example';

const { portalPublicBase, portalPublicOrigin } = await import('@/lib/public-base');
const { publishableKeyCallHeaders } = await import('@/lib/client-ip');
const { setSession, clearSession } = await import('@/lib/session');
const { requestSignInLinkAction, forgotPasswordAction } = await import('@/lib/actions');

const DOMAIN = 'billing.acme.test';

function onCustomDomain() {
  requestHeaders.set('x-rekey-portal-host', DOMAIN);
}

beforeEach(() => {
  for (const name of [...requestHeaders.keys()]) requestHeaders.delete(name);
  requestHeaders.set('host', 'portal.example');
  requestHeaders.set('x-forwarded-proto', 'https');
  jar.clear();
  posted.length = 0;
});

async function emailedUrl(action: () => Promise<void>, field: string): Promise<string> {
  await action().catch((err: unknown) => {
    if (!(err instanceof Error && err.message.startsWith('REDIRECT'))) throw err;
  });
  return String(posted.at(-1)?.body[field]);
}

describe('portalPublicBase', () => {
  it('is the shared host plus the slug on the shared host', async () => {
    expect(await portalPublicBase('acme')).toBe('https://portal.example/acme');
  });

  it('is the bare https origin of the domain on a custom domain', async () => {
    onCustomDomain();
    expect(await portalPublicBase('acme')).toBe('https://billing.acme.test');
  });

  it('never emits http for a custom domain, even on a plain-http request', async () => {
    onCustomDomain();
    requestHeaders.set('x-forwarded-proto', 'http');
    expect(await portalPublicBase('acme')).toMatch(/^https:\/\//);
    expect(await portalPublicOrigin()).toMatch(/^https:\/\//);
  });

  it('ignores a marker that is not a hostname', async () => {
    requestHeaders.set('x-rekey-portal-host', 'evil.example/acme');
    expect(await portalPublicBase('acme')).toBe('https://portal.example/acme');
  });
});

describe('publishable-key Origin', () => {
  it('is the shared origin on the shared host', async () => {
    expect((await publishableKeyCallHeaders()).origin).toBe('https://portal.example');
  });

  it('is the custom domain on a custom domain', async () => {
    onCustomDomain();
    expect((await publishableKeyCallHeaders()).origin).toBe('https://billing.acme.test');
  });
});

describe('emailed links', () => {
  const signIn = () => {
    const form = new FormData();
    form.set('email', 'a@b.test');
    return requestSignInLinkAction('acme', form);
  };
  const reset = () => {
    const form = new FormData();
    form.set('email', 'a@b.test');
    return forgotPasswordAction('acme', form);
  };

  it('point under /<slug> on the shared host', async () => {
    expect(await emailedUrl(signIn, 'signInUrl')).toBe('https://portal.example/acme/sign-in-link?token={token}');
    expect(await emailedUrl(reset, 'resetUrl')).toBe('https://portal.example/acme/reset-password-link?token={token}');
  });

  it('point at the custom domain with no slug on a custom domain', async () => {
    onCustomDomain();
    expect(await emailedUrl(signIn, 'signInUrl')).toBe('https://billing.acme.test/sign-in-link?token={token}');
    expect(await emailedUrl(reset, 'resetUrl')).toBe('https://billing.acme.test/reset-password-link?token={token}');
    expect(posted.at(-1)?.headers.get('origin')).toBe('https://billing.acme.test');
  });
});

describe('session cookie path', () => {
  it('is /<slug> on the shared host', async () => {
    await setSession('acme', 'a', 'r');
    expect(jar.get('rekey_portal_access')?.options.path).toBe('/acme');
    expect(jar.get('rekey_portal_refresh')?.options.path).toBe('/acme');
  });

  it('is / on a custom domain, for setting and clearing alike', async () => {
    onCustomDomain();
    await setSession('acme', 'a', 'r');
    expect(jar.get('rekey_portal_access')?.options.path).toBe('/');
    await clearSession('acme');
    expect(jar.get('rekey_portal_refresh')?.options).toMatchObject({ path: '/', maxAge: 0 });
  });
});
