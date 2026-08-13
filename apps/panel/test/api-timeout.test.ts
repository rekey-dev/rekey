/**
 * A hung API call must become an error, not a blank page.
 *
 * `lib/api.ts` had no deadline on its fetch, so a request that never got its
 * headers back sat on undici's default of five minutes. An operator saw that as
 * "saving goes blank and works if I refresh": while a server action's redirect
 * is in flight Next renders `null` for the page subtree — not loading.tsx, not
 * error.tsx — so a hung fetch on the far side of that redirect is an empty page
 * held open for as long as the socket stays quiet. The record was written. Only
 * the render never arrived.
 *
 * The invariant worth pinning is not the number of milliseconds. It is that a
 * timeout arrives as a `PanelApiError`, because that is what the error boundary
 * and the actions' catch blocks understand. An `AbortError` escaping raw would
 * miss every `err instanceof PanelApiError` branch in the app and land as an
 * unhandled render failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Cookie { value: string }

class FakeJar {
  private readonly store = new Map<string, Cookie>();
  get(name: string): Cookie | undefined {
    return this.store.get(name);
  }
  set(name: string, value: string): void {
    this.store.set(name, { value });
  }
  delete(name: string): void {
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

/** What `AbortSignal.timeout` produces once it fires. */
function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

beforeEach(() => {
  process.env.REKEY_URL = 'https://api.test';
  jar.seed('rekey_access', 'access-1');
  jar.seed('rekey_refresh', 'refresh-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('a request that never answers', () => {
  it('surfaces as a PanelApiError the app can catch, on a read', async () => {
    vi.stubGlobal('fetch', async () => {
      throw timeoutError();
    });
    const { api, PanelApiError } = await import('../src/lib/api.js');

    const err = await api({ method: 'GET', path: '/api/v1/tenant/applications' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PanelApiError);
    expect((err as InstanceType<typeof PanelApiError>).code).toBe('PANEL_UPSTREAM_TIMEOUT');
    expect((err as InstanceType<typeof PanelApiError>).statusCode).toBe(504);
  });

  it('does not claim a timed-out write failed, because it may well have applied', async () => {
    // The distinction matters: we stopped listening, which is not the same as
    // the API not having done it. "That failed, try again" is how an operator
    // configures a provider twice.
    vi.stubGlobal('fetch', async () => {
      throw timeoutError();
    });
    const { api, PanelApiError } = await import('../src/lib/api.js');

    const err = (await api({
      method: 'PUT',
      path: '/api/v1/tenant/applications/app1/billing-credentials/stripe',
      body: { data: {} },
    }).catch((e: unknown) => e)) as InstanceType<typeof PanelApiError>;

    expect(err.message).toContain('may or may not have been applied');
    expect(err.fix).toContain('check whether the change is there');
  });

  it('leaves other network failures alone', async () => {
    // Only the abort family is reinterpreted. A DNS or TLS failure is already a
    // real error with a real message and swallowing it into a timeout would
    // send the operator looking at the wrong thing.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const { api } = await import('../src/lib/api.js');

    const err = await api({ method: 'GET', path: '/api/v1/tenant/applications' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TypeError);
  });
});
