/**
 * `INTERNAL_CALLER_SECRET` goes to the API on every server-side call, and
 * nowhere else.
 *
 * On Rekey Cloud the panel reaches the API through its public origin, so the
 * API sees the panel host's egress address for every operator unless it can
 * tell that the forwarded client IP came from the panel. The secret is that
 * proof, which makes leaking it (to the browser, a log, another host) as bad
 * as letting a client pick its own rate-limit bucket.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'caller-secret-7f3a91';
const API = 'https://api.test';

const jar = new Map<string, string>();
/** The request headers as the middleware left them. */
let incoming = new Headers();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => void jar.set(n, v),
    delete: (n: string) => void jar.delete(n),
  }),
  headers: async () => incoming,
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  forbidden: () => {
    throw new Error('NEXT_FORBIDDEN');
  },
}));
vi.mock('../src/lib/cookie-secure', () => ({ cookieSecure: async () => true }));

interface Sent {
  url: string;
  headers: Headers;
}
let sent: Sent[] = [];
let expireFirst = false;

const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  process.env.REKEY_URL = API;
  sent = [];
  expireFirst = false;
  jar.clear();
  jar.set('rekey_access', 'access');
  jar.set('rekey_refresh', 'refresh-1');
  incoming = new Headers({
    'x-forwarded-for': '198.51.100.7',
    'x-rekey-internal-client-ip-source': 'peer',
  });
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    sent.push({ url: href, headers: new Headers(init?.headers as HeadersInit) });
    if (href.endsWith('/health/ready')) return new Response('{"status":"ok"}', { status: 200 });
    if (href.endsWith('/auth/refresh')) return ok({ accessToken: 'fresh', refreshToken: 'refresh-2' });
    if (expireFirst) {
      expireFirst = false;
      return new Response(JSON.stringify({ success: false, error: { code: 'TOKEN_EXPIRED', message: 'x' } }), { status: 401 });
    }
    return ok({ ok: true });
  });
});

afterEach(() => {
  delete process.env.INTERNAL_CALLER_SECRET;
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** One of every kind of call the panel makes to the API. */
async function everyCall(): Promise<void> {
  const api = await import('@/lib/api');
  expireFirst = true; // exercises the refresh exchange and the retry
  await api.api({ method: 'GET', path: '/api/v1/tenant/auth/me' });
  await api.api({ method: 'POST', path: '/api/v1/tenant/x', body: { a: 1 } });
  await api.publicPost('/api/v1/tenant/auth/sign-in', { email: 'a@b.c' });
  await api.publicGet('/api/v1/tenant/auth/signup-mode');
  await api.getReadyReport();
}

describe('INTERNAL_CALLER_SECRET', () => {
  it('is sent on every server-side call to the API, with the one validated client IP', async () => {
    process.env.INTERNAL_CALLER_SECRET = SECRET;
    await everyCall();
    expect(sent.length).toBeGreaterThanOrEqual(6);
    expect(sent.some((s) => s.url.endsWith('/auth/refresh'))).toBe(true);
    for (const s of sent) {
      expect(s.url.startsWith(API), s.url).toBe(true);
      expect(s.headers.get('x-rekey-caller-secret'), s.url).toBe(SECRET);
    }
    const withIp = sent.filter((s) => !s.url.endsWith('/health/ready'));
    for (const s of withIp) expect(s.headers.get('x-forwarded-for'), s.url).toBe('198.51.100.7');
  });

  it('adds nothing when unset', async () => {
    await everyCall();
    expect(sent.length).toBeGreaterThanOrEqual(6);
    for (const s of sent) expect(s.headers.has('x-rekey-caller-secret'), s.url).toBe(false);
  });

  it('adds nothing when blank', async () => {
    process.env.INTERNAL_CALLER_SECRET = '   ';
    await everyCall();
    for (const s of sent) expect(s.headers.has('x-rekey-caller-secret'), s.url).toBe(false);
  });

  it('never reaches a log or an error the page could render', async () => {
    process.env.INTERNAL_CALLER_SECRET = SECRET;
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ success: false, error: { code: 'INTERNAL', message: 'boom' } }), { status: 500 }),
    );
    const { api } = await import('@/lib/api');
    const err = await api({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(JSON.stringify(err) + String(err) + String((err as Error).stack)).not.toContain(SECRET);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
      spy.mockRestore();
    }
  });
});

describe('X-Rekey-Client-Ip', () => {
  const clientIp = async () => {
    const { apiCallerHeaders } = await import('@/lib/api');
    return (await apiCallerHeaders())['x-rekey-client-ip'];
  };

  it('carries the validated visitor on every call when the secret is set', async () => {
    process.env.INTERNAL_CALLER_SECRET = SECRET;
    await everyCall();
    for (const s of sent) expect(s.headers.get('x-rekey-client-ip'), s.url).toBe('198.51.100.7');
  });

  it('carries the visitor a trusted proxy reported', async () => {
    process.env.INTERNAL_CALLER_SECRET = SECRET;
    incoming.set('x-rekey-internal-client-ip-source', 'proxy');
    expect(await clientIp()).toBe('198.51.100.7');
  });

  it('is omitted when no visitor was validated, while X-Forwarded-For is still sent', async () => {
    process.env.INTERNAL_CALLER_SECRET = SECRET;
    // A proxy is configured but did not prove itself: the address left is the
    // proxy's (or a neighbour's), not the visitor's.
    incoming.set('x-rekey-internal-client-ip-source', 'none');
    const { apiCallerHeaders } = await import('@/lib/api');
    const h = await apiCallerHeaders();
    expect(h['x-rekey-client-ip']).toBeUndefined();
    expect(h['x-rekey-caller-secret']).toBe(SECRET);
    expect(h['x-forwarded-for']).toBe('198.51.100.7');
  });

  it('is omitted when the middleware did not run or said nothing', async () => {
    process.env.INTERNAL_CALLER_SECRET = SECRET;
    incoming.delete('x-rekey-internal-client-ip-source');
    expect(await clientIp()).toBeUndefined();
    incoming.set('x-rekey-internal-client-ip-source', 'bogus');
    expect(await clientIp()).toBeUndefined();
  });

  it('is omitted when there is no address at all, never a placeholder', async () => {
    process.env.INTERNAL_CALLER_SECRET = SECRET;
    incoming.delete('x-forwarded-for');
    expect(await clientIp()).toBeUndefined();
  });

  it('is never sent without the secret', async () => {
    await everyCall();
    for (const s of sent) expect(s.headers.has('x-rekey-client-ip'), s.url).toBe(false);
  });
});

describe('where the secret may appear in source', () => {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const f = path.join(dir, n);
      return statSync(f).isDirectory() ? files(f) : /\.(ts|tsx)$/.test(n) ? [f] : [];
    });

  it('is read only by lib/api.ts, which is server-only, and never under a NEXT_PUBLIC_ name', () => {
    const readers = files(srcDir).filter((f) => /INTERNAL_CALLER_SECRET/.test(readFileSync(f, 'utf8')));
    expect(readers.map((f) => path.relative(srcDir, f))).toEqual([path.join('lib', 'api.ts')]);
    const api = readFileSync(path.join(srcDir, 'lib', 'api.ts'), 'utf8');
    expect(api).not.toMatch(/^['"]use client['"]/m);
    expect(api).toMatch(/from 'next\/headers'/);
    for (const f of files(srcDir)) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*CALLER/);
    }
  });

  it('no client component imports the header builder', () => {
    const clients = files(srcDir).filter((f) => /^['"]use client['"]/.test(readFileSync(f, 'utf8')));
    for (const f of clients) expect(readFileSync(f, 'utf8'), f).not.toMatch(/apiCallerHeaders|CALLER_SECRET/);
  });

  it('the two export route handlers, which fetch REKEY_URL themselves, send it too', () => {
    for (const rel of [
      'app/(authed)/audit-log/export/route.ts',
      'app/(authed)/applications/[id]/end-users/[euid]/export/route.ts',
    ]) {
      expect(readFileSync(path.join(srcDir, rel), 'utf8'), rel).toMatch(/\.\.\.\(await apiCallerHeaders\(\)\)/);
    }
  });
});
