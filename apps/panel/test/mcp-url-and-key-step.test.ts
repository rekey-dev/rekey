/**
 * Two small panel fixes from the reorganisation's deferred list.
 *
 * - Account > Operator MCP printed `<set NEXT_PUBLIC_API_URL>` in every
 *   snippet on a deployment that never set it, although the API knows its own
 *   public address and publishes it in the MCP protected-resource metadata.
 * - The Applications checklist looked for an API key on the newest application
 *   only, so "Mint your first API key" went unticked the moment a second
 *   application was created after the key was minted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'access' }), set: () => undefined, delete: () => undefined }),
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

describe('getOperatorMcpUrl', () => {
  let body: unknown;
  let status: number;
  let calls: string[];

  beforeEach(() => {
    process.env.REKEY_URL = 'http://api:3030';
    calls = [];
    status = 200;
    body = { resource: 'https://api.rekey.example/api/v1/tenant/mcp' };
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('asks the API for its public MCP address, not the in-cluster one', async () => {
    const { getOperatorMcpUrl } = await import('@/lib/api');
    expect(await getOperatorMcpUrl(1)).toBe('https://api.rekey.example/api/v1/tenant/mcp');
    expect(calls).toEqual(['http://api:3030/api/v1/tenant/mcp/.well-known/oauth-protected-resource']);
  });

  it('caches an answer but never a failure', async () => {
    const { getOperatorMcpUrl } = await import('@/lib/api');
    status = 404;
    expect(await getOperatorMcpUrl(1)).toBeNull();
    status = 200;
    await getOperatorMcpUrl(2);
    await getOperatorMcpUrl(3);
    expect(calls).toHaveLength(2);
  });

  it('refuses a resource that is not a public URL', async () => {
    const { getOperatorMcpUrl } = await import('@/lib/api');
    body = { resource: 'http://api:3030/api/v1/tenant/mcp' };
    expect(await getOperatorMcpUrl(1)).toBeNull();
  });
});

describe('the "Mint your first API key" step', () => {
  const app = (id: string) =>
    ({ id, name: id, authConfig: { methods: ['password'] }, billingConfig: { enabled: false } }) as never;
  let keys: Record<string, unknown>;

  beforeEach(() => {
    process.env.REKEY_URL = 'https://api.test';
    keys = {};
    vi.stubGlobal('fetch', async (url: string) => {
      const m = /applications\/([^/]+)\/api-keys$/.exec(url);
      if (m) {
        const k = keys[m[1]!];
        if (k === 'fail') return new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'x' } }), { status: 500 });
        return new Response(JSON.stringify({ success: true, data: k ?? [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, data: { items: [], page: { total: 0, limit: 25, offset: 0 } } }), {
        status: 200,
      });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function keyStep(apps: string[]): Promise<{ done: boolean } | undefined> {
    const { buildOnboardingSteps } = await import('@/app/(authed)/applications/onboarding-steps');
    const { steps } = await buildOnboardingSteps(apps.map(app));
    return steps.find((s) => s.key === 'api-key');
  }

  it('ticks when an older application holds the key', async () => {
    keys.old = [{ id: 'k', revokedAt: null }];
    expect((await keyStep(['new', 'old']))?.done).toBe(true);
  });

  it('stays unticked when no application has an active key', async () => {
    keys.old = [{ id: 'k', revokedAt: '2026-09-01T00:00:00Z' }];
    expect((await keyStep(['new', 'old']))?.done).toBe(false);
  });

  it('is left out only when every read failed', async () => {
    keys.new = 'fail';
    keys.old = 'fail';
    expect(await keyStep(['new', 'old'])).toBeUndefined();
    keys.old = [];
    expect((await keyStep(['new', 'old']))?.done).toBe(false);
  });
});
