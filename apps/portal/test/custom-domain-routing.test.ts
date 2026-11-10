/**
 * The middleware on an Application's verified custom domain: the host is
 * looked up once, `/x` runs the `/<slug>/x` page, `/<slug>/x` is sent to `/x`,
 * checkout goes to the shared host, and the shared host behaves as before.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { middleware } from '@/middleware';

const TEST_TOKEN = 'cs_test_abcdefghijklmnopqrstuvwx';
const PROXY_SECRET = 'proxy-secret-value';

const verified: Record<string, string> = {};
const lookups: string[] = [];

vi.stubGlobal('fetch', async (input: string) => {
  const host = new URL(input).searchParams.get('host') ?? '';
  lookups.push(host);
  const slug = verified[host];
  if (!slug) return new Response('{"success":false}', { status: 404 });
  return Response.json({ success: true, data: { slug, name: 'Acme' } });
});

const saved = { ...process.env };
afterAll(() => {
  process.env = saved;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  process.env.PORTAL_BASE_URL = 'https://portal.example';
  process.env.REKEY_URL = 'http://api.internal:3030';
  process.env.PORTAL_PROXY_SECRET = PROXY_SECRET;
  lookups.length = 0;
});

let domainCount = 0;
/** A fresh verified domain per test: the resolver remembers answers. */
function verifiedDomain(slug = 'acme'): string {
  const domain = `billing${++domainCount}.acme.test`;
  verified[domain] = slug;
  return domain;
}

async function on(host: string, path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return (await middleware(
    new NextRequest(`http://localhost:3050${path}`, { method: init.method, headers: { host, ...init.headers } }),
  )) as NextResponse;
}

const rewrittenTo = (res: NextResponse) => {
  const target = res.headers.get('x-middleware-rewrite');
  return target ? new URL(target).pathname + new URL(target).search : null;
};
const location = (res: NextResponse) => {
  const at = res.headers.get('location');
  return at ? new URL(at, 'http://localhost:3050').href.replace('http://localhost:3050', '') : null;
};

describe('host resolution', () => {
  it('serves a verified domain under its slug and forwards the domain to the render', async () => {
    const domain = verifiedDomain();
    const res = await on(domain, '/plans?tab=all');
    expect(rewrittenTo(res)).toBe('/acme/plans?tab=all');
    expect(res.headers.get('x-middleware-request-x-rekey-portal-host')).toBe(domain);
    expect(res.headers.get('x-middleware-request-x-rekey-return-to')).toBe('/acme/plans?tab=all');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('maps the home page to the slug root', async () => {
    expect(rewrittenTo(await on(verifiedDomain(), '/'))).toBe('/acme');
  });

  it('asks the API by bare lower-case host, without the port', async () => {
    const domain = verifiedDomain();
    await on(`${domain.toUpperCase()}:443`, '/');
    expect(lookups).toEqual([domain]);
  });

  it('answers an unverified host with an empty 404 and never serves a page', async () => {
    const res = await on('unverified.example.org', '/acme/plans');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
  });

  it('remembers both answers, so repeat requests cost no API call', async () => {
    const domain = verifiedDomain();
    await on(domain, '/');
    await on(domain, '/plans');
    await on('nobody.example.org', '/');
    await on('nobody.example.org', '/');
    expect(lookups).toEqual([domain, 'nobody.example.org']);
  });

  it('answers 503 with Retry-After when the API cannot say, and remembers nothing', async () => {
    const domain = 'down.example.org';
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 502 });
    try {
      const res = await on(domain, '/');
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
    } finally {
      globalThis.fetch = original;
    }
    verified[domain] = 'acme';
    expect(rewrittenTo(await on(domain, '/'))).toBe('/acme');
  });
});

describe('the slug prefix on a custom domain', () => {
  it('sends /<slug>/x permanently to /x, keeping the query', async () => {
    const domain = verifiedDomain();
    const res = await on(domain, '/acme/login?step=link');
    expect(res.status).toBe(308);
    expect(location(res)).toBe('/login?step=link');
  });

  it('sends /<slug> to /', async () => {
    const res = await on(verifiedDomain(), '/acme');
    expect(res.status).toBe(308);
    expect(location(res)).toBe('/');
  });

  it("treats another application's slug as an ordinary path under this one", async () => {
    verified['other.example.org'] = 'other';
    const res = await on(verifiedDomain(), '/other/plans');
    expect(rewrittenTo(res)).toBe('/acme/other/plans');
  });

  it('keeps the token landing routes free of the session redirect, and hides the token from Referer on the hop', async () => {
    const domain = verifiedDomain();
    const stale = { cookie: 'rekey_portal_refresh=r1' };
    const landing = await on(domain, '/sign-in-link?token=t1', { headers: stale });
    expect(rewrittenTo(landing)).toBe('/acme/sign-in-link?token=t1');
    expect(landing.headers.get('x-middleware-request-x-rekey-portal-host')).toBe(domain);

    const oldForm = await on(domain, '/acme/sign-in-link?token=t1');
    expect(location(oldForm)).toBe('/sign-in-link?token=t1');
    expect(oldForm.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('sends a stale session to the refresh route by its slug-free path', async () => {
    const res = await on(verifiedDomain(), '/plans', { headers: { cookie: 'rekey_portal_refresh=r1' } });
    expect(res.status).toBe(307);
    expect(location(res)).toBe(`/session/refresh?next=${encodeURIComponent('/acme/plans')}`);
  });

  it('rewrites a Server Action POST to the page that owns the action', async () => {
    const domain = verifiedDomain();
    const res = await on(domain, '/login', {
      method: 'POST',
      headers: { 'next-action': 'abc', origin: `https://${domain}` },
    });
    expect(rewrittenTo(res)).toBe('/acme/login');
  });
});

describe('hostile paths on a custom domain', () => {
  it.each([
    ['/acme//evil.example', '/'],
    ['/acme//evil.example/x?y=1', '/?y=1'],
    ['/acme/%2F%2Fevil.example', '/%2F%2Fevil.example'],
    ['/acme/%5Cevil.example', '/%5Cevil.example'],
  ])('%s never leaves this host', async (path, expected) => {
    const res = await on(verifiedDomain(), path);
    expect(res.status).toBe(308);
    expect(location(res)).toBe(expected);
    expect(new URL(res.headers.get('location')!, 'http://localhost:3050').host).toBe('localhost:3050');
  });

  it('a backslash path is normalised by the URL parser before it reaches the check', async () => {
    const res = await middleware(
      new NextRequest('http://localhost:3050/acme/\\evil.example', { headers: { host: verifiedDomain() } }),
    );
    expect(new URL(res.headers.get('location')!, 'http://localhost:3050').host).toBe('localhost:3050');
  });
});

describe('which header names the host', () => {
  it('ignores X-Forwarded-Host without the proxy secret', async () => {
    const domain = verifiedDomain();
    const res = await on('portal.example', '/acme/plans', { headers: { 'x-forwarded-host': domain } });
    expect(lookups).toEqual([]);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('x-middleware-request-x-rekey-portal-host')).toBeNull();
  });

  it('ignores X-Forwarded-Host with a wrong proxy secret', async () => {
    const domain = verifiedDomain();
    await on('portal.example', '/', { headers: { 'x-forwarded-host': domain, 'x-rekey-proxy-secret': 'guess' } });
    expect(lookups).toEqual([]);
  });

  it('believes X-Forwarded-Host from the proxy that holds the secret', async () => {
    const domain = verifiedDomain();
    const res = await on('portal:3050', '/plans', {
      headers: { 'x-forwarded-host': domain, 'x-rekey-proxy-secret': PROXY_SECRET },
    });
    expect(rewrittenTo(res)).toBe('/acme/plans');
  });

  it('drops a client copy of the custom-domain marker on the shared host', async () => {
    const forged = { 'x-rekey-portal-host': 'billing.victim.test' };
    for (const path of ['/acme/plans', '/acme/sign-in-link?token=t', `/acme/checkout/${TEST_TOKEN}`]) {
      const res = await on('portal.example', path, { headers: forged });
      expect(res.headers.get('x-middleware-request-x-rekey-portal-host')).toBeNull();
      expect(res.headers.get('x-middleware-override-headers')).not.toContain('x-rekey-portal-host');
      expect(res.headers.get('x-middleware-override-headers')).toBeTruthy();
    }
  });

  it('replaces a client copy of the marker on a custom domain', async () => {
    const domain = verifiedDomain();
    const res = await on(domain, '/', { headers: { 'x-rekey-portal-host': 'billing.victim.test' } });
    expect(res.headers.get('x-middleware-request-x-rekey-portal-host')).toBe(domain);
  });
});

describe('checkout on a custom domain', () => {
  it.each([`/checkout/${TEST_TOKEN}`, `/acme/checkout/${TEST_TOKEN}/approved`])(
    'sends %s to the shared host under the slug',
    async (path) => {
      const res = await on(verifiedDomain(), `${path}?x=1`);
      expect(res.status).toBe(307);
      const target = new URL(res.headers.get('location')!);
      expect(target.origin).toBe('https://portal.example');
      expect(target.pathname).toBe(`/acme/checkout/${TEST_TOKEN}${path.endsWith('/approved') ? '/approved' : ''}`);
      expect(target.search).toBe('?x=1');
    },
  );
});

describe('the shared host', () => {
  const paths = [
    '/acme',
    '/acme/plans?tab=all',
    '/acme/sign-in-link?token=t1',
    `/acme/checkout/${TEST_TOKEN}`,
    '/acme/session/refresh?next=%2Facme',
  ];
  const cookies = [undefined, 'rekey_portal_refresh=r1'];

  it('answers as it did before custom domains, and asks the API nothing', async () => {
    const seen: string[] = [];
    for (const path of paths) {
      for (const cookie of cookies) {
        const res = await on('portal.example', path, { headers: cookie ? { cookie } : {} });
        const names = [...res.headers.keys()].filter((n) => !n.startsWith('x-middleware-request-')).sort().join(',');
        seen.push(`${path} ${cookie ?? '-'} ${res.status} ${res.headers.get('location') ?? '-'} ${names}`);
      }
    }
    expect(seen).toMatchInlineSnapshot(`
      [
        "/acme - 200 - content-security-policy,x-middleware-next,x-middleware-override-headers",
        "/acme rekey_portal_refresh=r1 307 http://localhost:3050/acme/session/refresh?next=%2Facme cache-control,content-security-policy,location",
        "/acme/plans?tab=all - 200 - content-security-policy,x-middleware-next,x-middleware-override-headers",
        "/acme/plans?tab=all rekey_portal_refresh=r1 307 http://localhost:3050/acme/session/refresh?next=%2Facme%2Fplans%3Ftab%3Dall cache-control,content-security-policy,location",
        "/acme/sign-in-link?token=t1 - 200 - content-security-policy,x-middleware-next",
        "/acme/sign-in-link?token=t1 rekey_portal_refresh=r1 200 - content-security-policy,x-middleware-next",
        "/acme/checkout/cs_test_abcdefghijklmnopqrstuvwx - 200 - cache-control,content-security-policy-report-only,referrer-policy,x-middleware-next,x-middleware-override-headers,x-robots-tag",
        "/acme/checkout/cs_test_abcdefghijklmnopqrstuvwx rekey_portal_refresh=r1 200 - cache-control,content-security-policy-report-only,referrer-policy,x-middleware-next,x-middleware-override-headers,x-robots-tag",
        "/acme/session/refresh?next=%2Facme - 200 - content-security-policy,x-middleware-next,x-middleware-override-headers",
        "/acme/session/refresh?next=%2Facme rekey_portal_refresh=r1 200 - content-security-policy,x-middleware-next,x-middleware-override-headers",
      ]
    `);
    expect(lookups).toEqual([]);
  });

  it('answers synchronously, as before', () => {
    const res = middleware(new NextRequest('http://localhost:3050/acme', { headers: { host: 'portal.example' } }));
    expect(res).not.toBeInstanceOf(Promise);
  });

  it('serves IP addresses and single-label hosts as the shared host', async () => {
    for (const host of ['127.0.0.1:3050', '[::1]:3050', 'localhost:3050', 'portal:3050']) {
      const res = await on(host, '/acme/plans');
      expect(res.headers.get('x-middleware-next')).toBe('1');
    }
    expect(lookups).toEqual([]);
  });
});
