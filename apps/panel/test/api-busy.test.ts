/**
 * A busy API (429 / 503) is "retry shortly", never "you are signed out" and
 * never "this account has no data".
 *
 * Three things went wrong under a shared rate limit, all observed on a
 * production build: a 429 on the token refresh signed the operator out, a 429
 * during a render reached the generic "Something went wrong" boundary, and a
 * 429 on a secondary read rendered an empty section that looked like real
 * data. These tests pin the fixes in `lib/api.ts` and `lib/api-busy.ts`, and
 * the one Next runtime fact the client half depends on.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_AUTO_RETRIES,
  MAX_RETRY_AFTER_SECONDS,
  autoRetryDelaySeconds,
  busyDigest,
  parseBusyDigest,
  parseRetryAfter,
} from '../src/lib/api-busy';

// ── fakes ──────────────────────────────────────────────────────────────────

class FakeJar {
  private readonly store = new Map<string, { value: string }>();
  public deletes = 0;
  get(name: string): { value: string } | undefined {
    return this.store.get(name);
  }
  set(name: string, value: string): void {
    this.store.set(name, { value });
  }
  delete(name: string): void {
    this.deletes += 1;
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

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** What the refresh endpoint answers, and what every other endpoint answers. */
let refreshReply: () => Response;
let dataReply: () => Response;
let refreshCalls = 0;

beforeEach(() => {
  process.env.REKEY_URL = 'https://api.test';
  refreshCalls = 0;
  jar.deletes = 0;
  jar.seed('rekey_access', 'expired-access');
  jar.seed('rekey_refresh', 'refresh-1');
  refreshReply = () => json(200, { success: true, data: { accessToken: 'fresh', refreshToken: 'refresh-2' } });
  dataReply = () => json(401, { success: false, error: { code: 'TOKEN_EXPIRED', message: 'expired' } });

  vi.stubGlobal('fetch', async (url: string | URL): Promise<Response> => {
    if (String(url).endsWith('/api/v1/tenant/auth/refresh')) {
      refreshCalls += 1;
      return refreshReply();
    }
    return dataReply();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const rateLimited = (seconds: number) =>
  json(
    429,
    { success: false, error: { code: 'RATE_LIMITED', message: `Retry in ${seconds}s.`, retryAfterSeconds: seconds } },
    { 'retry-after': String(seconds) },
  );

// ── refresh ────────────────────────────────────────────────────────────────

describe('a rate-limited token refresh', () => {
  it('a 429 on refresh is a retryable error, not a sign-out', async () => {
    refreshReply = () => rateLimited(12);
    const { api, isApiBusy } = await import('@/lib/api');

    const err = await api({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(String(err)).not.toMatch(/NEXT_REDIRECT/);
    expect(isApiBusy(err)).toBe(true);
    expect(err).toMatchObject({ statusCode: 429, retryAfterSeconds: 12, digest: 'PANEL_API_BUSY;429;12' });
    // The session is intact: nothing was cleared, and the refresh token is the
    // same unspent one, so the next attempt can use it.
    expect(jar.deletes).toBe(0);
    expect(jar.get('rekey_refresh')?.value).toBe('refresh-1');
  });

  it('a 503 on refresh signs out: the API may already have rotated the token', async () => {
    // tenant-auth.service.ts refresh() commits the rotation, THEN reads the user
    // and memberships; a database drop there answers 503 with the token spent.
    // Replaying it trips reuse detection and revokes every session.
    refreshReply = () =>
      json(503, { success: false, error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'down' } }, { 'retry-after': '5' });
    const { api } = await import('@/lib/api');

    await expect(api({ method: 'GET', path: '/x' })).rejects.toThrow(/NEXT_REDIRECT:\/login\?reason=expired/);
  });

  it('any other 5xx on refresh signs out too', async () => {
    refreshReply = () => json(500, { success: false, error: { code: 'INTERNAL', message: 'boom' } });
    const { api } = await import('@/lib/api');

    await expect(api({ method: 'GET', path: '/x' })).rejects.toThrow(/NEXT_REDIRECT:\/login\?reason=expired/);
  });

  it('a refused refresh (401) still signs out', async () => {
    refreshReply = () => json(401, { success: false, error: { code: 'INVALID_REFRESH_TOKEN', message: 'spent' } });
    const { api } = await import('@/lib/api');

    await expect(api({ method: 'GET', path: '/x' })).rejects.toThrow(/NEXT_REDIRECT:\/login\?reason=expired/);
  });

  it('concurrent callers share the one busy answer', async () => {
    refreshReply = () => rateLimited(3);
    const { api, isApiBusy } = await import('@/lib/api');

    const errs = await Promise.all(
      ['/a', '/b', '/c'].map((p) => api({ method: 'GET', path: p }).catch((e: unknown) => e)),
    );
    expect(errs.every((e) => isApiBusy(e))).toBe(true);
    expect(refreshCalls).toBe(1);
  });
});

// ── ordinary calls ─────────────────────────────────────────────────────────

describe('a busy API on an ordinary call', () => {
  it('throws a busy PanelApiError carrying Retry-After in the digest', async () => {
    dataReply = () => rateLimited(30);
    const { api, isApiBusy } = await import('@/lib/api');

    const err = await api({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(isApiBusy(err)).toBe(true);
    expect((err as { digest?: string }).digest).toBe(busyDigest(429, 30));
    expect(parseBusyDigest((err as { digest?: string }).digest)).toEqual({ status: 429, retryAfterSeconds: 30 });
  });

  it('a non-busy failure carries no digest, so Next keeps hashing it', async () => {
    dataReply = () => json(500, { success: false, error: { code: 'INTERNAL', message: 'boom' } });
    const { api } = await import('@/lib/api');

    const err = await api({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect((err as { digest?: string }).digest).toBeUndefined();
  });

  it('unlessBusy falls back on a real failure and rethrows a busy one', async () => {
    const { PanelApiError, unlessBusy } = await import('@/lib/api');
    const fallback = unlessBusy(() => 'empty');

    expect(fallback(new PanelApiError({ code: 'INTERNAL', message: 'x', statusCode: 500 }))).toBe('empty');
    const busy = new PanelApiError({ code: 'RATE_LIMITED', message: 'x', statusCode: 429, retryAfterSeconds: 4 });
    expect(() => fallback(busy)).toThrow(busy);
  });
});

// ── pure helpers ───────────────────────────────────────────────────────────

describe('parseRetryAfter', () => {
  it('reads delta-seconds, an HTTP date, then the envelope, then a default', () => {
    expect(parseRetryAfter('17')).toBe(17);
    const now = Date.parse('2026-09-19T10:00:00Z');
    expect(parseRetryAfter('Sat, 19 Sep 2026 10:00:40 GMT', undefined, now)).toBe(40);
    expect(parseRetryAfter(null, 9)).toBe(9);
    expect(parseRetryAfter(null)).toBe(5);
  });

  it('is clamped, so a hostile or broken header cannot stall or spin the UI', () => {
    expect(parseRetryAfter('0')).toBe(1);
    expect(parseRetryAfter('86400')).toBe(MAX_RETRY_AFTER_SECONDS);
  });
});

describe('parseBusyDigest', () => {
  it('ignores every digest that is not ours', () => {
    expect(parseBusyDigest(undefined)).toBeNull();
    expect(parseBusyDigest('1234567890')).toBeNull();
    expect(parseBusyDigest('NEXT_REDIRECT;replace;/x;307;')).toBeNull();
    expect(parseBusyDigest('PANEL_API_BUSY;500;3')).toBeNull();
  });
});

describe('autoRetryDelaySeconds', () => {
  it('never retries sooner than the API asked', () => {
    for (let attempt = 0; attempt < MAX_AUTO_RETRIES; attempt++) {
      expect(autoRetryDelaySeconds(attempt, 45)).toBeGreaterThanOrEqual(45);
    }
  });

  it('backs off when the API asks for almost nothing, rather than polling every second', () => {
    expect([0, 1, 2].map((a) => autoRetryDelaySeconds(a, 1))).toEqual([2, 4, 8]);
  });

  it('stops after a bounded number of attempts', () => {
    expect(autoRetryDelaySeconds(MAX_AUTO_RETRIES, 1)).toBeNull();
    expect(MAX_AUTO_RETRIES).toBeLessThanOrEqual(5);
  });
});

// ── the Next fact the client half relies on ────────────────────────────────

describe('installed Next runtime', () => {
  it('keeps a digest the thrown error already carries', () => {
    const nextDir = path.dirname(createRequire(import.meta.url).resolve('next/package.json'));
    const src = readFileSync(path.join(nextDir, 'dist/server/app-render/create-error-handler.js'), 'utf8');
    // Production strips a Server Component error to its digest. If an upgrade
    // started overwriting an existing digest, the busy notice would silently
    // turn back into "Something went wrong".
    expect(src).toMatch(/if \(!err\.digest\) \{\s*\/\/[^\n]*\n\s*err\.digest = /);
  });
});

describe('the per-tab automatic retry budget', () => {
  it('allows three automatic retries, then leaves it to the operator', async () => {
    const { createRetryBudget } = await import('../src/lib/api-busy');
    let t = 0;
    const budget = createRetryBudget(() => t);
    const delays: Array<number | null> = [];
    for (let i = 0; i < 5; i++) {
      const d = budget.nextDelay(1);
      delays.push(d);
      if (d === null) break;
      t += d * 1000;
      budget.recordAttempt();
    }
    expect(delays).toEqual([2, 4, 8, null]);
  });

  it('never schedules sooner than Retry-After', async () => {
    const { createRetryBudget } = await import('../src/lib/api-busy');
    let t = 0;
    const budget = createRetryBudget(() => t);
    for (let i = 0; i < 3; i++) {
      expect(budget.nextDelay(45)).toBe(45);
      t += 45_000;
      budget.recordAttempt();
    }
    expect(budget.nextDelay(45)).toBeNull();
  });

  it('counts across remounts, and resets after two quiet minutes or by hand', async () => {
    const { createRetryBudget, RETRY_QUIET_RESET_MS } = await import('../src/lib/api-busy');
    let t = 0;
    const budget = createRetryBudget(() => t);
    for (let i = 0; i < 3; i++) budget.recordAttempt();
    // A remounted boundary asks again: still spent.
    expect(budget.nextDelay(1)).toBeNull();
    t += RETRY_QUIET_RESET_MS + 1;
    expect(budget.nextDelay(1)).toBe(2);
    for (let i = 0; i < 3; i++) budget.recordAttempt();
    expect(budget.nextDelay(1)).toBeNull();
    budget.reset();
    expect(budget.nextDelay(1)).toBe(2);
  });
});
