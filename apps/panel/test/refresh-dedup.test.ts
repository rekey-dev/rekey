/**
 * One refresh per expiry, however many components hit a 401 at once.
 *
 * Refresh tokens rotate and are single-use, so a second concurrent exchange of
 * the same token gets a 401 from the API — correct behaviour, but it means the
 * loser of the race is thrown out to `/login?reason=expired`. Every RSC on a
 * page calls `api()` independently, so a navigation just after the 15-minute
 * access token expires used to fire several refreshes in the same millisecond
 * and sign the operator out. `lib/api.ts` dedupes them on the token.
 *
 * That is a concurrency invariant, and concurrency invariants rot silently.
 * A fake cookie jar plus a counting fetch stub is all it takes to pin it: two
 * concurrent `api()` calls must issue exactly ONE refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── fakes ──────────────────────────────────────────────────────────────────

interface Cookie { value: string }

class FakeJar {
  private readonly store = new Map<string, Cookie>();
  /** Set to true to emulate a Server Component, where Next forbids writes. */
  public readOnly = false;

  get(name: string): Cookie | undefined {
    return this.store.get(name);
  }
  set(name: string, value: string): void {
    if (this.readOnly) throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
    this.store.set(name, { value });
  }
  delete(name: string): void {
    if (this.readOnly) throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
    this.store.delete(name);
  }
  seed(name: string, value: string): void {
    this.store.set(name, { value });
  }
}

const jar = new FakeJar();

vi.mock('next/headers', () => ({
  cookies: async () => jar,
  headers: async () => new Headers(),
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

/** Counts what the panel actually sent, per endpoint. */
let refreshCalls = 0;
let dataCalls = 0;
/** How many times the refresh endpoint should succeed before rejecting reuse. */
let refreshesRemaining = 1;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  process.env.REKEY_URL = 'https://api.test';
  refreshCalls = 0;
  dataCalls = 0;
  refreshesRemaining = 1;
  jar.readOnly = false;
  jar.seed('rekey_access', 'expired-access');
  jar.seed('rekey_refresh', 'refresh-1');

  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);

    if (href.endsWith('/api/v1/tenant/auth/refresh')) {
      refreshCalls += 1;
      // Single-use: the API invalidates the presented token on first use, so a
      // SECOND exchange of the same token is a 401. This stub reproduces that
      // exactly — which is what makes the assertion meaningful. Without the
      // dedupe, the second caller lands here and is signed out.
      if (refreshesRemaining <= 0) {
        return jsonResponse(401, { success: false, error: { code: 'INVALID_REFRESH_TOKEN', message: 'spent' } });
      }
      refreshesRemaining -= 1;
      return jsonResponse(200, {
        success: true,
        data: { accessToken: 'fresh-access', refreshToken: 'refresh-2' },
      });
    }

    dataCalls += 1;
    const auth = new Headers(init?.headers as HeadersInit).get('authorization');
    if (auth !== 'Bearer fresh-access') {
      return jsonResponse(401, { success: false, error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
    }
    return jsonResponse(200, { success: true, data: { ok: href } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ── the invariant ──────────────────────────────────────────────────────────

describe('api() refresh dedup', () => {
  it('issues ONE refresh for two concurrent calls that both hit a 401', async () => {
    const { api } = await import('@/lib/api');

    const [a, b] = await Promise.all([
      api<{ ok: string }>({ method: 'GET', path: '/one' }),
      api<{ ok: string }>({ method: 'GET', path: '/two' }),
    ]);

    expect(refreshCalls).toBe(1);
    expect(a.ok).toContain('/one');
    expect(b.ok).toContain('/two');
    // Two 401s + two retries = 4 data requests; the refresh is the shared one.
    expect(dataCalls).toBe(4);
  });

  it('issues ONE refresh for five concurrent calls', async () => {
    const { api } = await import('@/lib/api');

    await Promise.all(
      ['/a', '/b', '/c', '/d', '/e'].map((path) => api<{ ok: string }>({ method: 'GET', path })),
    );

    expect(refreshCalls).toBe(1);
  });

  it('refreshes again on a LATER expiry rather than replaying a resolved promise', async () => {
    const { api } = await import('@/lib/api');

    await api<{ ok: string }>({ method: 'GET', path: '/first' });
    expect(refreshCalls).toBe(1);

    // Second expiry: the cookie now holds the rotated token, and the entry for
    // the old one was deleted in a `finally`. A cached promise here would
    // hand back a token the API has already invalidated.
    jar.seed('rekey_access', 'expired-again');
    refreshesRemaining = 1;
    await api<{ ok: string }>({ method: 'GET', path: '/second' });
    expect(refreshCalls).toBe(2);
  });

  it('signs out when refresh itself fails', async () => {
    refreshesRemaining = 0;
    const { api } = await import('@/lib/api');

    await expect(api({ method: 'GET', path: '/one' })).rejects.toThrow(/NEXT_REDIRECT:\/login\?reason=expired/);
  });

  it('bounces through /sign-out when cookies cannot be written (server component)', async () => {
    refreshesRemaining = 0;
    jar.readOnly = true;
    const { api } = await import('@/lib/api');

    await expect(api({ method: 'GET', path: '/one' })).rejects.toThrow(/NEXT_REDIRECT:\/sign-out\?reason=expired/);
  });
});
