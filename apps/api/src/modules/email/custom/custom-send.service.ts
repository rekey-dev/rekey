/**
 * Sending a published custom template: `POST /api/v1/email/send` and the
 * operator test send. Pure refusals first, then idempotency, suppression, caps, send.
 */

import { createHash } from 'node:crypto';
import type { Application, CustomEmailTemplateVersion, EmailLog } from '@prisma/client';
import type { EmailSendResult } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { sendEmail, type SendOutcome } from '../../../lib/email-transport.js';
import { sendableTo, type SendKind } from '../send-policy.js';
import {
  deliveryFailed,
  idempotencyKeyReused,
  noFromAddress,
  recipientNotEndUser,
  sendInFlight,
  sendOutcomeUnknown,
  senderDomainMismatch,
  templateNotFound,
  templateNotPublished,
  transportNotCustom,
  variablesInvalid,
  versionNotFound,
} from './errors.js';
import { customTransport, domainOf } from './custom-templates.service.js';
import { readVariableSchema, sampleValues, validateVariables } from './variables.js';
import { renderCustom } from './render-custom.js';
import { consumeSendAllowance } from './send-caps.js';
import { unsubscribeUrl } from './unsubscribe-token.js';

export interface SendRequest {
  template: string;
  to: string;
  variables: Record<string, unknown>;
  version?: number | undefined;
  idempotencyKey?: string | undefined;
}

/**
 * How long a `pending` row may stand before it is taken to have been
 * abandoned. A send is bounded at 10 s by the transport, so five minutes is
 * far past any live attempt.
 */
export const PENDING_CUTOFF_MS = 5 * 60 * 1000;

const UNKNOWN_OUTCOME_TEXT =
  'Outcome unknown: the send did not record a result within five minutes (process stopped or the log write failed).';

function fingerprintOf(req: SendRequest): string {
  const variables = Object.keys(req.variables)
    .sort()
    .map((k) => [k, req.variables[k]]);
  return createHash('sha256')
    .update(
      JSON.stringify({
        template: req.template,
        to: req.to.toLowerCase(),
        version: req.version ?? null,
        variables,
      }),
    )
    .digest('hex');
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === 'P2002';
}

/** Headers for `notification` mail: RFC 8058 one-click unsubscribe. `critical` mail has none. */
export function unsubscribeHeaders(
  category: string,
  applicationId: string,
  to: string,
): Record<string, string> | undefined {
  if (category !== 'notification') return undefined;
  const url = unsubscribeUrl(applicationId, to);
  if (url === null) return undefined;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

async function resolveVersion(
  applicationId: string,
  key: string,
  pinned: number | undefined,
): Promise<CustomEmailTemplateVersion> {
  const template = await prisma.customEmailTemplate.findUnique({
    where: { applicationId_key: { applicationId, key } },
    select: { id: true, version: true, status: true, deletedAt: true },
  });
  if (!template || template.deletedAt !== null) throw templateNotFound(key);
  if (template.status !== 'published') throw templateNotPublished(key);
  const wanted = pinned ?? template.version;
  const version = await prisma.customEmailTemplateVersion.findUnique({
    where: { templateId_version: { templateId: template.id, version: wanted } },
  });
  if (!version) throw versionNotFound(key, wanted, template.version);
  return version;
}

async function assertEndUser(applicationId: string, to: string): Promise<void> {
  const found = await prisma.endUser.findFirst({
    where: { applicationId, email: { equals: to, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!found) throw recipientNotEndUser();
}

/**
 * Mark pending rows past the cutoff as `unknown`. Called by a replay that
 * finds one, and by the periodic sweep for rows nobody replays.
 */
export async function resolveStalePendingSends(where: { id?: string } = {}): Promise<number> {
  const { count } = await prisma.emailLog.updateMany({
    where: { ...where, status: 'pending', createdAt: { lt: new Date(Date.now() - PENDING_CUTOFF_MS) } },
    data: { status: 'unknown', error: UNKNOWN_OUTCOME_TEXT },
  });
  return count;
}

/** What a stored row answers when the same key is sent again. */
async function replay(row: EmailLog, fingerprint: string): Promise<EmailSendResult> {
  if (row.idempotencyFingerprint !== fingerprint) throw idempotencyKeyReused();
  if (row.status === 'pending') {
    if (row.createdAt.getTime() > Date.now() - PENDING_CUTOFF_MS) throw sendInFlight();
    await resolveStalePendingSends({ id: row.id });
    throw sendOutcomeUnknown(row.id, true);
  }
  if (row.status === 'unknown') throw sendOutcomeUnknown(row.id, true);
  if (row.status === 'error') throw deliveryFailed(row.error ?? 'unknown error', row.id, true);
  return {
    id: row.id,
    status: row.status === 'sent' ? 'sent' : 'suppressed',
    template: row.customTemplateKey ?? '',
    version: row.customTemplateVersion ?? 0,
    ...(row.messageId !== null && { messageId: row.messageId }),
  };
}

type Reservation = { kind: 'reserved'; row: EmailLog } | { kind: 'replayed'; result: EmailSendResult };

/**
 * Insert the pending row that is the idempotency lock, or replay the row that
 * already holds the key. A holder can vanish between our failed insert and our
 * read (a cap refusal deletes its reservation), so the pair is retried rather
 * than surfacing a missing row as a 500.
 */
async function reserve(
  application: Application,
  req: SendRequest,
  version: number,
  fingerprint: string,
): Promise<Reservation> {
  const keyed = req.idempotencyKey !== undefined;
  const where = keyed
    ? { applicationId_idempotencyKey: { applicationId: application.id, idempotencyKey: req.idempotencyKey! } }
    : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (where) {
      const existing = await prisma.emailLog.findUnique({ where });
      if (existing) return { kind: 'replayed', result: await replay(existing, fingerprint) };
    }
    try {
      const row = await prisma.emailLog.create({
        data: {
          tenantId: application.tenantId,
          applicationId: application.id,
          toAddress: req.to.toLowerCase(),
          subject: `[pending] ${req.template}`,
          via: 'none',
          status: 'pending',
          idempotencyKey: req.idempotencyKey ?? null,
          idempotencyFingerprint: keyed ? fingerprint : null,
          customTemplateKey: req.template,
          customTemplateVersion: version,
        },
      });
      return { kind: 'reserved', row };
    } catch (e) {
      if (!keyed || !isUniqueViolation(e)) throw e;
    }
  }
  // Three rounds of losing the insert and then finding no holder: another
  // request is churning this key. Nothing was sent by this one.
  throw sendInFlight();
}

/**
 * Send one published custom template to one recipient.
 *
 * @example
 * ```ts
 * const result = await sendCustomEmail(application, {
 *   template: 'order_shipped',
 *   to: 'buyer@example.com',
 *   variables: { orderNumber: 'A-1042' },
 *   idempotencyKey: 'order-A-1042-shipped',
 * });
 * ```
 */
export async function sendCustomEmail(application: Application, req: SendRequest): Promise<EmailSendResult> {
  const transport = customTransport(application);
  if (!transport.eligible) throw transportNotCustom(transport.via);

  const version = await resolveVersion(application.id, req.template, req.version);
  if (!transport.fromAddress) throw noFromAddress();
  const currentDomain = domainOf(transport.fromAddress);
  if (currentDomain !== version.senderDomain) {
    throw senderDomainMismatch(req.template, version.version, version.senderDomain, currentDomain);
  }

  const schema = readVariableSchema(version.variableSchema);
  const { values, issues } = validateVariables(schema, version.linkDomains, req.variables);
  if (issues.length > 0) throw variablesInvalid(req.template, version.version, issues);

  if (application.emailRecipientsMustBeEndUsers) await assertEndUser(application.id, req.to);

  const keyed = req.idempotencyKey !== undefined;
  const reservation = await reserve(application, req, version.version, fingerprintOf(req));
  if (reservation.kind === 'replayed') return reservation.result;
  const reserved = reservation.row;
  const base = { id: reserved.id, template: req.template, version: version.version };

  const blocked = await sendableTo(application, req.to, version.category as SendKind);
  if (blocked !== null) {
    await prisma.emailLog.update({
      where: { id: reserved.id },
      data: { status: 'suppressed', subject: `[suppressed] ${req.template}`, error: blocked.text },
    });
    return { ...base, status: 'suppressed' };
  }

  try {
    await consumeSendAllowance(application.tenantId, req.to);
  } catch (e) {
    // Nothing was sent, so the key must stay usable once the window resets.
    await prisma.emailLog.deleteMany({ where: { id: reserved.id } });
    throw e;
  }

  const rendered = renderCustom(version, values);
  const headers = unsubscribeHeaders(version.category, application.id, req.to);
  const outcome: SendOutcome = await sendEmail(
    application,
    {
      to: req.to,
      ...rendered,
      ...(headers !== undefined && { headers }),
      ...(version.fromName !== null && { fromName: version.fromName }),
    },
    {
      logId: reserved.id,
      requireCustomTransport: true,
      customTemplateKey: req.template,
      customTemplateVersion: version.version,
    },
  );
  if (outcome.kind === 'sent') {
    return { ...base, status: 'sent', ...(outcome.messageId !== null && { messageId: outcome.messageId }) };
  }
  throw deliveryFailed(outcome.kind === 'error' ? outcome.message : 'no transport.', reserved.id, keyed);
}

/**
 * Render the DRAFT with sample values and send it to the signed-in operator.
 * Needs the same custom transport as a real send, honours the suppression
 * list, and counts against the caps so the button is not an unmetered sender.
 */
export async function testSendCustomTemplate(
  applicationId: string,
  key: string,
  operatorEmail: string,
): Promise<SendOutcome> {
  const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
  const transport = customTransport(application);
  if (!transport.eligible) throw transportNotCustom(transport.via);
  if (!transport.fromAddress) throw noFromAddress();

  const draft = await prisma.customEmailTemplate.findUnique({
    where: { applicationId_key: { applicationId, key } },
  });
  if (!draft || draft.deletedAt !== null) throw templateNotFound(key);

  const blocked = await sendableTo(application, operatorEmail, draft.category as SendKind, { testSend: true });
  if (blocked) {
    throw new RekeyError({
      statusCode: 409,
      code: 'EMAIL_ADDRESS_SUPPRESSED',
      message: `${operatorEmail} is on this Application's suppression list (${blocked.suppressionReason ?? blocked.reason}).`,
      fix: 'Remove your address from Email → Suppressions if you want test sends, or test from another operator account.',
    });
  }
  await consumeSendAllowance(application.tenantId, operatorEmail);

  const schema = readVariableSchema(draft.variableSchema);
  const rendered = renderCustom(draft, sampleValues(schema, draft.linkDomains));
  const headers = unsubscribeHeaders(draft.category, application.id, operatorEmail);
  return sendEmail(
    application,
    {
      to: operatorEmail,
      ...rendered,
      subject: `[TEST] ${rendered.subject}`,
      ...(headers !== undefined && { headers }),
      ...(draft.fromName !== null && { fromName: draft.fromName }),
    },
    { requireCustomTransport: true, customTemplateKey: key },
  );
}
