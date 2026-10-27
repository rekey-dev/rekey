/**
 * Retry all failed: the newest FAILED deliveries are requeued in batches small
 * enough to leave the operator's rate budget for the rest of the panel.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  method: string;
  path: string;
}
const calls: Call[] = [];
let failed: string[] = [];

let rateLimitAfter = Infinity;

vi.mock('@/lib/api', async () => {
  class PanelApiError extends Error {
    constructor(readonly statusCode: number) {
      super(`HTTP ${statusCode}`);
    }
  }
  return {
    PanelApiError,
    api: async (call: Call) => {
      calls.push(call);
      const url = new URL(call.path, 'http://x');
      if (call.method === 'POST') {
        if (calls.filter((c) => c.method === 'POST').length > rateLimitAfter) throw new PanelApiError(429);
        const id = url.pathname.split('/').at(-2);
        failed = failed.filter((f) => f !== id);
        return { queued: true };
      }
      expect(url.searchParams.get('status')).toBe('FAILED');
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      const items = failed.slice(offset, offset + limit).map((id) => ({ id }));
      return { items, page: { total: failed.length, limit, offset, hasMore: offset + limit < failed.length } };
    },
  };
});
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { retryAllFailed } = await import('@/app/(authed)/applications/[id]/webhooks/[endpointId]/actions');

const retried = (): string[] =>
  calls.filter((c) => c.method === 'POST').map((c) => c.path.split('/').at(-2) ?? '');

describe('retryAllFailed', () => {
  beforeEach(() => {
    calls.length = 0;
    rateLimitAfter = Infinity;
  });

  it('requeues every failure when they fit in one batch', async () => {
    failed = Array.from({ length: 60 }, (_, i) => `d${i}`);
    const all = [...failed];
    await expect(retryAllFailed('app_1', 'ep_1', '')).rejects.toThrow(
      'REDIRECT /applications/app_1/webhooks/ep_1?retriedAll=60&of=60',
    );
    expect(retried().sort()).toEqual(all.sort());
  });

  it('stops at the cap and says more remain', async () => {
    failed = Array.from({ length: 250 }, (_, i) => `d${i}`);
    await expect(retryAllFailed('app_1', 'ep_1', '')).rejects.toThrow('retriedAll=100&of=100&capped=1');
    expect(new Set(retried()).size).toBe(100);
  });

  it('stops at the first rate limit and says so', async () => {
    failed = Array.from({ length: 80 }, (_, i) => `d${i}`);
    rateLimitAfter = 30;
    await expect(retryAllFailed('app_1', 'ep_1', '')).rejects.toThrow('retriedAll=30&of=80&paused=1');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(31);
  });

  it('lands back on the same filter and page, and drops anything else', async () => {
    failed = ['d0'];
    await expect(
      retryAllFailed('app_1', 'ep_1', 'status=FAILED&offset=50&ps=100&next=%2F%2Fevil.com&ps=7'),
    ).rejects.toThrow('REDIRECT /applications/app_1/webhooks/ep_1?status=FAILED&offset=50&ps=100&retriedAll=1&of=1');
  });
});
