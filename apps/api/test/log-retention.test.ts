/**
 * The append-only log tables are pruned after LOG_RETENTION_DAYS, and an
 * archive, when configured, is written before anything is deleted.
 *
 * The cases that matter are the ones where a naive sweep would do damage:
 *
 *   - a PENDING webhook delivery is live retry state, not a log line;
 *   - a FAILED delivery an operator redelivered yesterday is not stale just
 *     because it was first created last month;
 *   - `usage_records` is a billing ledger whose idempotency keys stop a
 *     replayed usage event charging twice, it must survive any window;
 *   - an archive upload that fails must leave the rows where they are.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { archiveKey, pruneLogs, type LogArchiver } from '../src/lib/log-retention.js';
import { pruneWebhookEvents } from '../src/modules/billing/webhooks/retention.js';
import { createS3LogArchiver, resolveLogArchiveConfig } from '../src/lib/log-archive.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);

/** Raw SQL, because Prisma's @updatedAt would overwrite a backdated value. */
async function backdate(table: string, column: string, id: string, at: Date): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2`, at, id);
}

describe('pruneLogs', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  it('retention is opt-in: unset, both windows mean keep forever', () => {
    // The suite runs with neither variable set, which is exactly the upgraded
    // deployment that must not start deleting its audit trail. 0 is what
    // app.ts reads as "skip the sweep"; every prune test below passes its
    // window explicitly for that reason.
    expect(process.env.LOG_RETENTION_DAYS).toBeUndefined();
    expect(process.env.WEBHOOK_EVENT_RETENTION_DAYS).toBeUndefined();
    expect(env.LOG_RETENTION_DAYS).toBe(0);
    expect(env.WEBHOOK_EVENT_RETENTION_DAYS).toBe(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function application(slug: string): Promise<string> {
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-retention-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS retention ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    return app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: `App retention ${slug}`, slug: `retention-${slug}` },
      })
      .then((r) => (r.json().data as { id: string }).id);
  }

  it('prunes stale rows and keeps recent ones, live retry state and the billing ledger', async () => {
    const applicationId = await application('a');

    const oldEvent = await prisma.securityEvent.create({
      data: { type: 'user.signed_in', actorType: 'end_user', actorId: 'eu_old', applicationId },
    });
    const newEvent = await prisma.securityEvent.create({
      data: { type: 'user.signed_in', actorType: 'end_user', actorId: 'eu_new', applicationId },
    });
    await backdate('security_events', 'created_at', oldEvent.id, daysAgo(40));

    const oldEmail = await prisma.emailLog.create({
      data: { applicationId, toAddress: 'old@example.com', subject: 'Old', via: 'none', status: 'sent' },
    });
    const newEmail = await prisma.emailLog.create({
      data: { applicationId, toAddress: 'new@example.com', subject: 'New', via: 'none', status: 'sent' },
    });
    await backdate('email_logs', 'created_at', oldEmail.id, daysAgo(40));

    const endpoint = await prisma.webhookEndpoint.create({
      data: { applicationId, url: 'https://example.com/hook', secret: 'whsec_retention_test' },
    });
    const delivery = (status: 'PENDING' | 'SUCCEEDED' | 'FAILED', eventId: string) =>
      prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          applicationId,
          eventId,
          eventType: 'user.created',
          payload: {},
          status,
        },
      });
    const oldSucceeded = await delivery('SUCCEEDED', 'evt_1');
    const oldFailed = await delivery('FAILED', 'evt_2');
    const oldPending = await delivery('PENDING', 'evt_3');
    const redeliveredYesterday = await delivery('FAILED', 'evt_4');
    for (const d of [oldSucceeded, oldFailed, oldPending, redeliveredYesterday]) {
      await backdate('webhook_deliveries', 'created_at', d.id, daysAgo(40));
    }
    for (const d of [oldSucceeded, oldFailed, oldPending]) {
      await backdate('webhook_deliveries', 'updated_at', d.id, daysAgo(40));
    }
    await backdate('webhook_deliveries', 'updated_at', redeliveredYesterday.id, daysAgo(1));

    const meter = await prisma.usageMeter.create({
      data: { applicationId, slug: 'api-calls', name: 'API calls', unit: 'call' },
    });
    const usage = await prisma.usageRecord.create({
      data: { meterId: meter.id, quantity: 1, idempotencyKey: 'retention-idem-1' },
    });
    await backdate('usage_records', 'created_at', usage.id, daysAgo(400));
    await backdate('usage_records', 'occurred_at', usage.id, daysAgo(400));

    const result = await pruneLogs({ retentionDays: 30 });
    expect(result.failures).toEqual([]);

    const exists = {
      event: (id: string) => prisma.securityEvent.count({ where: { id } }),
      email: (id: string) => prisma.emailLog.count({ where: { id } }),
      delivery: (id: string) => prisma.webhookDelivery.count({ where: { id } }),
    };

    expect(await exists.event(oldEvent.id)).toBe(0);
    expect(await exists.event(newEvent.id)).toBe(1);
    expect(await exists.email(oldEmail.id)).toBe(0);
    expect(await exists.email(newEmail.id)).toBe(1);

    expect(await exists.delivery(oldSucceeded.id)).toBe(0);
    expect(await exists.delivery(oldFailed.id)).toBe(0);
    // Live retry state, however old.
    expect(await exists.delivery(oldPending.id)).toBe(1);
    // Created 40 days ago, touched yesterday: not stale.
    expect(await exists.delivery(redeliveredYesterday.id)).toBe(1);

    // The ledger is never in scope.
    expect(await prisma.usageRecord.count({ where: { id: usage.id } })).toBe(1);
  });

  it('refuses a window that is not positive rather than deleting everything', async () => {
    // app.ts maps an unset window to null and skips the sweep. These guards are
    // for the next caller that forgets: a zero window would put the cutoff at
    // now and take every row, including the receipts that make retries no-ops.
    const applicationId = await application('zero');

    const ancientEvent = await prisma.securityEvent.create({
      data: { type: 'user.signed_in', actorType: 'end_user', actorId: 'eu_zero', applicationId },
    });
    await backdate('security_events', 'created_at', ancientEvent.id, daysAgo(400));

    const ancientEmail = await prisma.emailLog.create({
      data: { applicationId, toAddress: 'zero@example.com', subject: 'Zero', via: 'none', status: 'sent' },
    });
    await backdate('email_logs', 'created_at', ancientEmail.id, daysAgo(400));

    const ancientReceipt = await prisma.webhookEvent.create({
      data: {
        applicationId,
        provider: 'stripe',
        providerEventId: 'evt_zero_retention',
        eventType: 'invoice.paid',
        payload: {},
      },
    });
    await backdate('webhook_events', 'received_at', ancientReceipt.id, daysAgo(400));

    for (const days of [0, -1, Number.NaN]) {
      const result = await pruneLogs({ retentionDays: days });
      expect(result.deleted).toEqual({ security_events: 0, email_logs: 0, webhook_deliveries: 0 });
      expect(await pruneWebhookEvents(days)).toBe(0);
    }

    expect(await prisma.securityEvent.count({ where: { id: ancientEvent.id } })).toBe(1);
    expect(await prisma.emailLog.count({ where: { id: ancientEmail.id } })).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { id: ancientReceipt.id } })).toBe(1);

    // These rows survived on purpose; the archive test below counts objects per
    // day and would archive them too.
    await prisma.securityEvent.delete({ where: { id: ancientEvent.id } });
    await prisma.emailLog.delete({ where: { id: ancientEmail.id } });
    await prisma.webhookEvent.delete({ where: { id: ancientReceipt.id } });
  });

  it('writes the archive before deleting, one object per table per day', async () => {
    const applicationId = await application('b');
    const puts = new Map<string, Uint8Array>();
    const archiver: LogArchiver = {
      async put(key, body) {
        puts.set(key, body);
      },
    };

    const first = await prisma.securityEvent.create({
      data: { type: 'user.signed_in', actorType: 'end_user', actorId: 'eu_a1', applicationId },
    });
    const second = await prisma.securityEvent.create({
      data: { type: 'user.signed_in', actorType: 'end_user', actorId: 'eu_a2', applicationId },
    });
    await backdate('security_events', 'created_at', first.id, new Date('2026-01-10T12:00:00Z'));
    await backdate('security_events', 'created_at', second.id, new Date('2026-01-11T12:00:00Z'));

    await pruneLogs({ retentionDays: 30, archiver });

    const keys = [...puts.keys()].filter((k) => k.startsWith('security_events/'));
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.startsWith('security_events/dt=2026-01-10/'))).toBe(true);
    expect(keys.some((k) => k.startsWith('security_events/dt=2026-01-11/'))).toBe(true);

    const archivedIds = keys.flatMap((k) =>
      gunzipSync(puts.get(k)!)
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { id: string; actorId: string }).id),
    );
    expect(archivedIds.sort()).toEqual([first.id, second.id].sort());

    expect(await prisma.securityEvent.count({ where: { id: { in: [first.id, second.id] } } })).toBe(0);
  });

  it('leaves rows in place when the archive rejects', async () => {
    const applicationId = await application('c');
    const event = await prisma.securityEvent.create({
      data: { type: 'user.signed_in', actorType: 'end_user', actorId: 'eu_kept', applicationId },
    });
    await backdate('security_events', 'created_at', event.id, daysAgo(40));

    const archiver: LogArchiver = {
      async put() {
        throw new Error('bucket unreachable');
      },
    };
    const result = await pruneLogs({ retentionDays: 30, archiver });

    expect(result.failures.map((f) => f.table)).toContain('security_events');
    expect(await prisma.securityEvent.count({ where: { id: event.id } })).toBe(1);
  });
});

describe('archiveKey', () => {
  it('is stable across id order, so a retried upload overwrites its own object', () => {
    expect(archiveKey('email_logs', '2026-01-10', ['b', 'a', 'c'])).toBe(
      archiveKey('email_logs', '2026-01-10', ['c', 'b', 'a']),
    );
    expect(archiveKey('email_logs', '2026-01-10', ['a'])).not.toBe(
      archiveKey('email_logs', '2026-01-10', ['b']),
    );
  });
});

describe('resolveLogArchiveConfig', () => {
  const full = {
    LOG_ARCHIVE_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
    LOG_ARCHIVE_S3_BUCKET: 'rekey-logs',
    LOG_ARCHIVE_S3_ACCESS_KEY_ID: 'AKIA_TEST',
    LOG_ARCHIVE_S3_SECRET_ACCESS_KEY: 'secret_test',
  };

  it('is off when nothing is set', () => {
    expect(resolveLogArchiveConfig({})).toBeNull();
  });

  it('refuses a partial set and names what is missing', () => {
    expect(() =>
      resolveLogArchiveConfig({ LOG_ARCHIVE_S3_BUCKET: 'rekey-logs' }),
    ).toThrow(/LOG_ARCHIVE_S3_ENDPOINT, LOG_ARCHIVE_S3_ACCESS_KEY_ID, LOG_ARCHIVE_S3_SECRET_ACCESS_KEY/);
  });

  it('normalises the endpoint, region and prefix', () => {
    expect(resolveLogArchiveConfig({ ...full, LOG_ARCHIVE_S3_PREFIX: '/rekey/prod/' })).toEqual({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'rekey-logs',
      region: 'auto',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret_test',
      prefix: 'rekey/prod/',
    });
  });

  it('refuses a prefix that would need URL encoding', () => {
    expect(() => resolveLogArchiveConfig({ ...full, LOG_ARCHIVE_S3_PREFIX: 'logs?x=1' })).toThrow(
      /LOG_ARCHIVE_S3_PREFIX/,
    );
  });
});

describe('createS3LogArchiver', () => {
  const config = resolveLogArchiveConfig({
    LOG_ARCHIVE_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    LOG_ARCHIVE_S3_BUCKET: 'rekey-logs',
    LOG_ARCHIVE_S3_ACCESS_KEY_ID: 'AKIA_TEST',
    LOG_ARCHIVE_S3_SECRET_ACCESS_KEY: 'secret_test',
    LOG_ARCHIVE_S3_PREFIX: 'rekey',
  })!;

  it('sends a signed path-style PUT with Content-MD5 over the exact bytes', async () => {
    let captured: Request | undefined;
    const archiver = createS3LogArchiver(config, async (input) => {
      captured = input as Request;
      return new Response(null, { status: 200 });
    });
    const body = new TextEncoder().encode('{"id":"x"}\n');

    await archiver.put('security_events/dt=2026-01-10/abc.ndjson.gz', body);

    expect(captured).toBeDefined();
    expect(captured!.method).toBe('PUT');
    expect(captured!.url).toBe(
      'https://acct.r2.cloudflarestorage.com/rekey-logs/rekey/security_events/dt=2026-01-10/abc.ndjson.gz',
    );
    expect(captured!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA_TEST\//);
    expect(captured!.headers.get('content-md5')).toBe(createHash('md5').update(body).digest('base64'));
    expect(captured!.headers.get('content-encoding')).toBe('gzip');
  });

  it('rejects on a non-2xx, which is what stops the delete', async () => {
    const archiver = createS3LogArchiver(config, async () => new Response('AccessDenied', { status: 403 }));
    await expect(archiver.put('k', new Uint8Array([1]))).rejects.toThrow(/HTTP 403.*AccessDenied/);
  });
});
