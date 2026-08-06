import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { rekeyMiddleware } from '../src/middleware.js';

const get = (p: string) => new NextRequest(new URL(`https://app.example${p}`));

describe('PROBE middleware', () => {
  it('dumps exemption behaviour', () => {
    const probe = (cfg: any, paths: string[]) => {
      const mw = rekeyMiddleware(cfg);
      const lines = paths.map((p) => {
        const r = mw(get(p));
        return `    ${p.padEnd(26)} ${r.status === 200 ? 'PUBLIC' : 'redirect -> ' + new URL(r.headers.get('location')!).pathname}`;
      });
      console.log('cfg=' + JSON.stringify(cfg) + '\n' + lines.join('\n'));
    };
    probe({ publicRoutes: [], signInUrl: '/sign-in' }, ['/sign-in', '/sign-in-admin', '/sign-inx', '/sign-in/reset', '/dashboard']);
    probe({ publicRoutes: [], signInUrl: '/' }, ['/', '/dashboard', '//evil', '/a/b']);
    probe({ publicRoutes: [], signInUrl: '/auth' }, ['/auth', '/auth/callback', '/auth/admin/keys']);
    probe({ publicRoutes: [], signInUrl: '/login?from=gate' }, ['/login']);
    probe({ publicRoutes: [], signInUrl: '/login/' }, ['/login', '/login/']);
    expect(true).toBe(true);
  });
});

// ---- auth() sequence probe against a rotating, reuse-detecting fake API ----
const jar = new Map<string, string>();
let sealed = true;
const cookieJar = {
  get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
  set: (n: string, v: string) => { if (sealed) throw new Error('sealed'); jar.set(n, v); },
  delete: (n: string) => { if (sealed) throw new Error('sealed'); jar.delete(n); },
};
vi.mock('next/headers', () => ({
  cookies: async () => cookieJar,
  headers: async () => new Headers({ 'x-forwarded-proto': 'https', host: 'app.example' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

class FakeRekeyError extends Error { constructor(public code: string) { super(code); } }

// Model of apps/api auth.service.refresh: single-use rotation, family revocation.
const rows = new Map<string, { replacedBy: string | null; revoked: boolean }>();
let n = 0;
let familyDead = false;
const events: string[] = [];
const refresh = vi.fn(async (tok: string) => {
  const row = rows.get(tok);
  if (!row) throw new FakeRekeyError('REFRESH_TOKEN_INVALID');
  if (row.revoked || row.replacedBy) {
    if (row.replacedBy) {
      familyDead = true;
      for (const r of rows.values()) r.revoked = true;
      events.push('!! REFRESH_TOKEN_REUSED -> family revoked');
      throw new FakeRekeyError('REFRESH_TOKEN_REUSED');
    }
    events.push('!! REFRESH_TOKEN_REVOKED');
    throw new FakeRekeyError('REFRESH_TOKEN_REVOKED');
  }
  const next = `r${++n}`;
  row.replacedBy = next;
  rows.set(next, { replacedBy: null, revoked: false });
  events.push(`   rotated ${tok} -> ${next}`);
  return { accessToken: `a${n}`, refreshToken: next };
});
const getCurrentUser = vi.fn(async (t: string) => {
  if (!t.startsWith('a')) throw new FakeRekeyError('USER_TOKEN_INVALID');
  return { id: 'u1', email: 'a@b.c' };
});
vi.mock('@rekey.dev/node', () => ({
  Rekey: class { auth = { getCurrentUser, refresh }; },
  RekeyError: FakeRekeyError,
}));
process.env.REKEY_URL = 'https://api.example';
process.env.REKEY_SECRET = 'rp_test_x';
const { auth } = await import('../src/server.js');

beforeEach(() => { jar.clear(); rows.clear(); events.length = 0; n = 0; familyDead = false; sealed = true; });

describe('PROBE auth() lifetime with a rotating API', () => {
  it('sequential requests after the access cookie expires', async () => {
    rows.set('r0', { replacedBy: null, revoked: false });
    jar.set('rekey_refresh', 'r0'); // access cookie already expired away

    for (let req = 1; req <= 3; req++) {
      let outcome: string;
      try { outcome = JSON.stringify(await auth()); }
      catch (e) { outcome = 'THREW ' + (e as FakeRekeyError).code; }
      events.push(`req#${req} -> ${outcome}`);
    }
    console.log('SEQUENTIAL (sealed jar / server component):\n' + events.join('\n'));
  });

  it('one render, layout + page both call auth() concurrently', async () => {
    rows.set('r0', { replacedBy: null, revoked: false });
    jar.set('rekey_refresh', 'r0');
    const results = await Promise.allSettled([auth(), auth()]);
    console.log('CONCURRENT layout+page:\n' + events.join('\n') + '\n' +
      results.map((r, i) => `  call${i}: ${r.status} ${r.status === 'fulfilled' ? JSON.stringify(r.value) : (r.reason as any).code}`).join('\n'));
  });

  it('what happens once the family is revoked (writable jar)', async () => {
    sealed = false;
    rows.set('r0', { replacedBy: null, revoked: true }); // deliberately revoked, e.g. signed out elsewhere
    jar.set('rekey_refresh', 'r0');
    let outcome: string;
    try { outcome = JSON.stringify(await auth()); } catch (e) { outcome = 'THREW ' + (e as FakeRekeyError).code; }
    console.log('REVOKED refresh cookie -> ' + outcome + ' ; cookies left = ' + JSON.stringify([...jar.keys()]));
  });

  it('unknown refresh cookie (stale / wrong env)', async () => {
    sealed = false;
    jar.set('rekey_refresh', 'never-issued');
    let outcome: string;
    try { outcome = JSON.stringify(await auth()); } catch (e) { outcome = 'THREW ' + (e as FakeRekeyError).code; }
    console.log('UNKNOWN refresh cookie -> ' + outcome + ' ; cookies left = ' + JSON.stringify([...jar.keys()]));
  });
});
