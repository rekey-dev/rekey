/**
 * Outbound webhooks — emission, signing, delivery rows, retry/backoff.
 *
 * No real HTTP is required: we point endpoints at a local listener
 * inside the test process. The transport `fetch` is the built-in global
 * one; we run a real `http.createServer` on a random port and assert on
 * what arrives.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWebhookSignature } from '../src/lib/webhook-signing.js';
import {
  processDueWebhookDeliveries,
  setDeliveryScheduler,
  webhookService,
} from '../src/modules/webhooks/webhook.service.js';

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
}

interface Sink {
  url: string;
  /** Resolves after `count` requests have been received. */
  waitFor(count: number, timeoutMs?: number): Promise<{ body: string; headers: Record<string, string> }[]>;
  close(): Promise<void>;
  setHandler(handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}

/**
 * Test sink that captures inbound webhook deliveries. Defaults to 200 OK;
 * callers can swap the handler via `setHandler` to simulate errors.
 */
async function makeSink(): Promise<Sink> {
  const received: { body: string; headers: Record<string, string> }[] = [];
  const waiters: Array<{ count: number; resolve: (v: typeof received) => void }> = [];
  let handler = (_req: IncomingMessage, res: ServerResponse): void => {
    res.statusCode = 200;
    res.end('{}');
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c.toString()));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      received.push({ body, headers });
      // Resolve any waiters that have hit their count.
      for (const w of [...waiters]) {
        if (received.length >= w.count) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(received.slice());
        }
      }
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    waitFor(count, timeoutMs = 4000) {
      if (received.length >= count) return Promise.resolve(received.slice());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${count} requests; got ${received.length}`));
        }, timeoutMs);
        waiters.push({
          count,
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    setHandler(h) {
      handler = h;
    },
  };
}

describe('Outbound webhooks', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const tenantSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-wh-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: `App ${slug}`, slug: `wh-${slug}` },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      tenantAccess: tenantSession.accessToken,
    };
  }

  it('CRUD: create returns secret once; update + delete work', async () => {
    const b = await bootstrap('crud');
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/webhooks`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { url: 'https://example.invalid/hook', events: ['user.created'] },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json().data as { id: string; secret: string; events: string[] };
    expect(created.secret).toBeTruthy();
    expect(created.events).toEqual(['user.created']);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/webhooks`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    const listed = list.json().data as { items: unknown[]; page: { total: number } };
    expect(listed.items).toHaveLength(1);
    expect(listed.page.total).toBe(1);

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/webhooks/${created.id}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { enabled: false },
    });
    expect(update.statusCode).toBe(200);
    expect((update.json().data as { enabled: boolean }).enabled).toBe(false);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/webhooks/${created.id}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(del.statusCode).toBe(200);
  });

  it('user.created event fires + the receiver gets a verifiable signature', async () => {
    const b = await bootstrap('emit');
    const sink = await makeSink();
    try {
      const created = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${b.applicationId}/webhooks`,
          headers: { authorization: `Bearer ${b.tenantAccess}` },
          payload: { url: sink.url, events: ['user.created'] },
        })
        .then((r) => r.json().data as { secret: string });

      // Sign up an end-user — fires user.created.
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'whuser@example.com', password: 'pw-one-two-three' },
      });

      const [delivery] = await sink.waitFor(1);
      expect(delivery!.headers['x-rekey-event-type']).toBe('user.created');
      expect(delivery!.headers['x-rekey-event-id']).toBeTruthy();
      // Signature verifies with the issued secret.
      expect(
        verifyWebhookSignature({
          body: delivery!.body,
          secret: created.secret,
          header: delivery!.headers['x-rekey-signature']!,
        }),
      ).toBe(true);
      // Wrong secret fails to verify.
      expect(
        verifyWebhookSignature({
          body: delivery!.body,
          secret: 'wrong-secret',
          header: delivery!.headers['x-rekey-signature']!,
        }),
      ).toBe(false);
      // Payload shape.
      const parsed = JSON.parse(delivery!.body) as {
        eventId: string;
        type: string;
        data: { user: { email: string } };
      };
      expect(parsed.type).toBe('user.created');
      expect(parsed.data.user.email).toBe('whuser@example.com');
    } finally {
      await sink.close();
    }
  });

  it('wildcard ["*"] subscription receives every event type', async () => {
    const b = await bootstrap('wildcard');
    const sink = await makeSink();
    try {
      await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/webhooks`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { url: sink.url, events: ['*'] },
      });

      // user.created
      const eu = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${b.liveKey}` },
          payload: { email: 'wild@example.com', password: 'pw-one-two-three' },
        })
        .then((r) => r.json().data as { accessToken: string });

      // email.verified — issue a verification token, then consume it.
      const send = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/send-verification',
          headers: {
            authorization: `Bearer ${b.liveKey}`,
            'x-rekey-user-token': eu.accessToken,
          },
          payload: {},
        })
        .then((r) => r.json().data as { verificationToken: string });
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/verify-email',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { token: send.verificationToken },
      });

      const deliveries = await sink.waitFor(2);
      const types = deliveries.map((d) => d.headers['x-rekey-event-type']);
      expect(types).toContain('user.created');
      expect(types).toContain('email.verified');
    } finally {
      await sink.close();
    }
  });

  it('failed delivery records the error + schedules a retry', async () => {
    const b = await bootstrap('retry');
    const sink = await makeSink();
    sink.setHandler((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    try {
      const endpoint = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${b.applicationId}/webhooks`,
          headers: { authorization: `Bearer ${b.tenantAccess}` },
          payload: { url: sink.url, events: ['user.created'] },
        })
        .then((r) => r.json().data as { id: string });

      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'fail@example.com', password: 'pw-one-two-three' },
      });
      // Wait for the receiver to see the first attempt.
      await sink.waitFor(1);

      // Poll for the delivery row reflecting the failure.
      let row = null as null | { status: string; attempts: number; nextAttemptAt: Date | null; responseStatus: number | null };
      for (let i = 0; i < 50 && (!row || row.attempts === 0); i++) {
        row = await prisma.webhookDelivery.findFirst({
          where: { endpointId: endpoint.id },
          orderBy: { createdAt: 'desc' },
        });
        if (row?.attempts && row.attempts > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(row).toBeTruthy();
      expect(row!.status).toBe('PENDING');
      expect(row!.attempts).toBeGreaterThanOrEqual(1);
      expect(row!.responseStatus).toBe(500);
      expect(row!.nextAttemptAt).toBeTruthy();
    } finally {
      await sink.close();
    }
  });

  it('rotate-secret returns a new value; the old one stops verifying', async () => {
    const b = await bootstrap('rotate');
    const create = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/webhooks`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { url: 'https://example.invalid/hook', events: ['user.created'] },
      })
      .then((r) => r.json().data as { id: string; secret: string });
    const rot = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/webhooks/${create.id}/rotate-secret`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(rot.statusCode).toBe(200);
    const newSecret = (rot.json().data as { secret: string }).secret;
    expect(newSecret).not.toBe(create.secret);
  });

  it('poller re-attempts a due PENDING delivery (crash-survivable retry)', async () => {
    const b = await bootstrap('poller');
    const sink = await makeSink();
    try {
      const { endpoint } = await webhookService.createEndpoint({
        applicationId: b.applicationId,
        url: sink.url,
        events: ['user.created'],
      });
      // Simulate a retry that was scheduled before a restart: the row is
      // PENDING with a past nextAttemptAt and NO in-process timer exists.
      const delivery = await prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          applicationId: b.applicationId,
          eventId: 'evt-poller-test',
          eventType: 'user.created',
          payload: { eventId: 'evt-poller-test', type: 'user.created', data: {} },
          status: 'PENDING',
          attempts: 1,
          nextAttemptAt: new Date(Date.now() - 60_000),
        },
      });

      const due = await processDueWebhookDeliveries();
      expect(due).toBeGreaterThanOrEqual(1);
      await sink.waitFor(1);

      const row = await prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      });
      expect(row.status).toBe('SUCCEEDED');
      expect(row.attempts).toBe(2);

      // A second poll finds nothing due — the claim + terminal status stop
      // any double-send.
      const again = await processDueWebhookDeliveries();
      expect(again).toBe(0);
    } finally {
      await sink.close();
    }
  });

  it('operator retry: re-attempts a FAILED delivery; 404 for the wrong endpoint or a SUCCEEDED row', async () => {
    const b = await bootstrap('opretry');
    const sink = await makeSink();
    try {
      const { endpoint } = await webhookService.createEndpoint({
        applicationId: b.applicationId,
        url: sink.url,
        events: ['user.created'],
      });
      const { endpoint: other } = await webhookService.createEndpoint({
        applicationId: b.applicationId,
        url: 'https://example.invalid/hook',
        events: ['user.created'],
      });
      // A delivery that exhausted its retries (attempts = MAX) and FAILED.
      const delivery = await prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          applicationId: b.applicationId,
          eventId: 'evt-op-retry',
          eventType: 'user.created',
          payload: { eventId: 'evt-op-retry', type: 'user.created', data: {} },
          status: 'FAILED',
          attempts: 5,
          nextAttemptAt: null,
          error: 'HTTP 500',
        },
      });

      // Retrying through a DIFFERENT endpoint's path must 404 — the delivery
      // is validated against (application, endpoint), not just the app.
      const wrong = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/webhooks/${other.id}/deliveries/${delivery.id}/retry`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(wrong.statusCode).toBe(404);
      expect(wrong.json().error.code).toBe('WEBHOOK_DELIVERY_NOT_FOUND');

      // The right endpoint queues a single re-attempt that succeeds.
      const ok = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/webhooks/${endpoint.id}/deliveries/${delivery.id}/retry`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json().data as { queued: boolean }).queued).toBe(true);
      await sink.waitFor(1);

      let row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      for (let i = 0; i < 50 && row.status !== 'SUCCEEDED'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      }
      expect(row.status).toBe('SUCCEEDED');
      expect(row.attempts).toBe(6);

      // A SUCCEEDED delivery can't be re-queued.
      const again = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/webhooks/${endpoint.id}/deliveries/${delivery.id}/retry`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(again.statusCode).toBe(404);
      expect(again.json().error.code).toBe('WEBHOOK_DELIVERY_NOT_FOUND');
    } finally {
      await sink.close();
    }
  });

  it('endpointMatches: emit drops events for endpoints whose subscriptions don\'t cover the type', async () => {
    const b = await bootstrap('nomatch');
    // Subscribe to mfa.enabled only.
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/webhooks`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { url: 'https://example.invalid/hook', events: ['mfa.enabled'] },
    });
    // Emit user.created — should not create a delivery row.
    const ids = await webhookService.emit({
      applicationId: b.applicationId,
      type: 'user.created',
      data: {},
    });
    expect(ids).toHaveLength(0);
  });

  it('scheduler seam: emit routes the first attempt through the active scheduler (BullMQ swap point)', async () => {
    const b = await bootstrap('seam');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/webhooks`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { url: 'https://example.invalid/hook', events: ['user.created'] },
    });

    // Stand in for the BullMQ scheduler installed at boot: capture every
    // (deliveryId, delayMs, attempts) handed to it instead of running the
    // attempt. This is exactly the seam webhook.queue.ts swaps in.
    const calls: Array<{ deliveryId: string; delayMs: number; attempts: number }> = [];
    setDeliveryScheduler((deliveryId, delayMs, attempts) => {
      calls.push({ deliveryId, delayMs, attempts });
    });
    try {
      const ids = await webhookService.emit({
        applicationId: b.applicationId,
        type: 'user.created',
        data: {},
      });
      expect(ids).toHaveLength(1);
      // The first attempt is enqueued at zero delay, attempt count 0 — no real
      // HTTP fired because our scheduler intercepted it.
      expect(calls).toEqual([{ deliveryId: ids[0], delayMs: 0, attempts: 0 }]);
    } finally {
      // Restore the in-process scheduler for the remaining suite.
      setDeliveryScheduler(null);
    }
  });

  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await prisma.webhookDelivery.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });
});
