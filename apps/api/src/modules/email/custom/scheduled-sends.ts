/**
 * Scheduled custom sends: `POST /api/v1/email/send` with `sendAt` writes a
 * `scheduled` log row; the poller fires due rows through the normal send, so
 * the suppression list, topics, the recipient and the caps are all checked
 * again at the moment the mail goes.
 */

import { Prisma, type EmailLog } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { deliverReserved, prepareSend, type SendRequest } from './custom-send.service.js';
import { sendNotFound } from './errors.js';

/** Rows claimed per poll. A slow provider holds a poll for this many sends. */
const FIRE_BATCH = 50;

/** Refusals at fire time that mean the recipient should not get it, not that something broke. */
const RECIPIENT_REFUSALS = new Set(['EMAIL_RECIPIENT_NOT_FOUND', 'EMAIL_RECIPIENT_BANNED', 'EMAIL_RECIPIENT_UNVERIFIED', 'EMAIL_RECIPIENT_NOT_END_USER']);

interface StoredRequest {
  to: SendRequest['to'];
  variables: Record<string, unknown>;
}

async function fire(row: EmailLog, now: Date): Promise<void> {
  const stored = row.scheduledRequest as unknown as StoredRequest;
  const template = row.customTemplateKey!;
  try {
    const application = await prisma.application.findUniqueOrThrow({ where: { id: row.applicationId! } });
    const req: SendRequest = { template, to: stored.to, variables: stored.variables, version: row.customTemplateVersion ?? undefined };
    const prepared = await prepareSend(application, req);
    await deliverReserved(application, template, prepared, row.id, { keyed: row.idempotencyKey !== null, scheduled: true });
  } catch (e) {
    if (e instanceof RekeyError && e.code === 'EMAIL_RATE_LIMITED') {
      // A cap is a reason to wait, not to drop the send: due again once the window has room.
      const retryAfterSeconds = e.retryAfterSeconds ?? 60;
      await prisma.emailLog.updateMany({
        where: { id: row.id },
        data: { status: 'scheduled', error: null, subject: `[scheduled] ${template}`, sendAt: new Date(now.getTime() + retryAfterSeconds * 1000) },
      });
      return;
    }
    const refused = e instanceof RekeyError && RECIPIENT_REFUSALS.has(e.code);
    const text = e instanceof Error ? e.message : String(e);
    // A provider failure was already written by the transport; anything that
    // stopped the send before it gets its outcome here.
    await prisma.emailLog.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: refused ? 'suppressed' : 'error', subject: `[${refused ? 'suppressed' : 'error'}] ${template}`, error: text },
    });
  }
  await prisma.emailLog.updateMany({ where: { id: row.id, status: { not: 'scheduled' } }, data: { scheduledRequest: Prisma.DbNull } });
}

/**
 * Claim the due scheduled rows and send them. Claiming flips each row to
 * `pending` under `SKIP LOCKED`, so two pollers never send one row twice.
 * Returns how many were fired.
 *
 * @example
 * setInterval(() => void fireDueScheduledSends(), 15_000);
 */
export async function fireDueScheduledSends(now: Date = new Date()): Promise<number> {
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "email_logs" SET "status" = 'pending', "created_at" = ${now}
     WHERE "status" = 'scheduled' AND "id" IN (
       SELECT "id" FROM "email_logs"
        WHERE "status" = 'scheduled' AND "send_at" <= ${now}
        ORDER BY "send_at" ASC
        LIMIT ${FIRE_BATCH}
        FOR UPDATE SKIP LOCKED)
     RETURNING "id"`;
  if (claimed.length === 0) return 0;
  const rows = await prisma.emailLog.findMany({ where: { id: { in: claimed.map((c) => c.id) } } });
  for (const row of rows) {
    // One row failing (its Application deleted mid-poll) must not strand the rest of the batch.
    await fire(row, now).catch(() => undefined);
  }
  return rows.length;
}

/**
 * Cancel a scheduled send of this Application. Only a `scheduled` row can be
 * canceled; one already fired or canceled answers EMAIL_SEND_NOT_SCHEDULED.
 *
 * @example
 * await cancelScheduledSend(application.id, logId);
 */
export async function cancelScheduledSend(applicationId: string, id: string): Promise<EmailLog> {
  const { count } = await prisma.emailLog.updateMany({
    where: { id, applicationId, status: 'scheduled' },
    data: { status: 'canceled', scheduledRequest: Prisma.DbNull },
  });
  const row = await prisma.emailLog.findFirst({ where: { id, applicationId } });
  if (!row) throw sendNotFound();
  if (count === 0) {
    throw new RekeyError({
      statusCode: 409,
      code: 'EMAIL_SEND_NOT_SCHEDULED',
      message: `Send "${id}" is ${row.status}, so it cannot be canceled.`,
      fix: 'Only a send made with `sendAt` can be canceled, and only before it fires. Read it with GET /api/v1/email/sends/:id.',
    });
  }
  return row;
}
