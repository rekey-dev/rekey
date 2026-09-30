/**
 * The end-user Overview's Plan and Credits tiles. A member without
 * billing:read used to be told "billing could not be read", which reads as an
 * outage; it is a permission, and the tile should say so without asking.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let scopes: string[] | null = null;
const billingCalls: string[] = [];

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/components/Link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement('a', { href }, children as never),
}));
vi.mock('@/app/(authed)/applications/[id]/end-users/[euid]/actions', () => {
  const noop = async (): Promise<void> => undefined;
  return {
    releaseAllDevices: noop,
    revokeAllSessions: noop,
    sendPasswordReset: noop,
    sendVerification: noop,
    unlockAccount: noop,
    saveProfileAnswers: noop,
  };
});
vi.mock('@/app/(authed)/applications/[id]/end-users/[euid]/insights', async (orig) => ({
  ...(await orig<object>()),
  getEndUserInsights: async () => null,
}));
vi.mock('@/app/(authed)/applications/[id]/end-users/[euid]/shared', async (orig) => ({
  ...(await orig<object>()),
  readSupportFlash: async () => ({}),
  getEndUserDetail: async () => ({
    endUser: {
      id: 'eu_1',
      email: 'ada@example.org',
      emailVerified: true,
      role: 'user',
      createdAt: '2026-09-01T00:00:00Z',
      erasedAt: null,
      lockedUntil: null,
      failedSignInAttempts: 0,
      metadata: null,
    },
  }),
  getEndUserBilling: async () => {
    billingCalls.push('billing');
    return { subscriptions: [] };
  },
  getEndUserCredits: async () => {
    billingCalls.push('credits');
    return { balance: 0, ledger: [] };
  },
  getEndUserDeviceCounts: async () => ({ active: 1, total: 1, blocked: 0 }),
  getEndUserEvents: async () => [],
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<object>()),
  getApplication: async () => ({
    id: 'app_1',
    billingConfig: { enabled: true, currency: 'USD' },
    access: scopes === null ? undefined : { level: 'read', scopes },
  }),
}));

async function render(): Promise<string> {
  const { default: Page } = await import('@/app/(authed)/applications/[id]/end-users/[euid]/page');
  const tree = await Page({
    params: Promise.resolve({ id: 'app_1', euid: 'eu_1' }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(tree).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

beforeEach(() => {
  scopes = null;
  billingCalls.length = 0;
});

describe('end-user Overview', () => {
  it('says Plan and Credits are hidden, and does not ask, without billing:read', async () => {
    scopes = ['end-users:read'];
    const text = await render();
    expect(billingCalls).toEqual([]);
    expect(text).not.toContain('billing could not be read');
    expect(text).not.toContain('credit balance could not be read');
    expect(text.match(/not visible to your role/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('reads billing when the caller holds billing:read', async () => {
    scopes = ['end-users:read', 'billing:read'];
    const text = await render();
    expect(billingCalls.sort()).toEqual(['billing', 'credits']);
    expect(text).toContain('no subscription and no default plan');
  });
});
