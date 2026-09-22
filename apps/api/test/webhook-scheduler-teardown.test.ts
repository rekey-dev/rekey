/**
 * The in-process test scheduler's delivery timers stop with the app.
 *
 * They are process-global and the suite runs every file in one fork, so a
 * retry that outlived its app used to fire inside a LATER file. A 30s retry
 * scheduled by credit-events.test.ts (endpoints at https://example.invalid)
 * ran its claim UPDATE inside self-read-surface.test.ts's query-count window,
 * and that file's exact count came up one statement high.
 *
 * Only setTimeout/clearTimeout are faked, so the 30s backoff can be crossed
 * without waiting for it while Prisma, DNS and `setImmediate` stay real.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';

const CLAIM = /^UPDATE "public"\."webhook_deliveries" SET "next_attempt_at"/;

let listening = false;
let claims = 0;
function countClaims(): void {
  if (listening) return;
  listening = true;
  (prisma as unknown as { $on(e: 'query', cb: (e: { query: string }) => void): void }).$on(
    'query',
    (e) => {
      if (CLAIM.test(e.query)) claims++;
    },
  );
}

/** Yield to real I/O for `ms` of wall time, without touching the faked timers. */
async function drainFor(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) await new Promise((r) => setImmediate(r));
}

async function waitForAttempts(id: string, attempts: number): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const row = await prisma.webhookDelivery.findUnique({ where: { id }, select: { attempts: true } });
    if ((row?.attempts ?? 0) >= attempts) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`delivery ${id} never reached ${attempts} attempt(s)`);
}

describe('webhook delivery scheduler teardown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('app close cancels a retry the test scheduler still holds', async () => {
    countClaims();
    const app = await buildApp({ logger: false });
    await app.ready();
    const slug = Math.random().toString(36).slice(2, 8);
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `wst-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operator}` },
        payload: { name: 'WST', slug: `wst-${slug}` },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await webhookService.createEndpoint({
      applicationId: appId,
      url: 'https://example.invalid/teardown',
      events: ['user.created'],
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const [id] = await webhookService.emit({ applicationId: appId, type: 'user.created', data: {} });
    vi.advanceTimersByTime(0);
    // The first attempt fails (the host does not resolve) and schedules its
    // 30s retry through the test scheduler.
    await waitForAttempts(id!, 1);
    await drainFor(100);

    await app.close();
    const before = claims;
    vi.advanceTimersByTime(31_000);
    await drainFor(300);

    expect(claims - before, 'a retry ran its claim after the app closed').toBe(0);
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: id! } });
    expect(row.attempts).toBe(1);
    expect(row.status).toBe('PENDING');
  });
});
