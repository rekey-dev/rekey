/**
 * An Application's sender identity: the display name its mail goes out under,
 * where replies go, and the support address templates can show. Stored in
 * `emailConfig` beside the BYO `fromAddress`, and written by key-level merges
 * so saving credentials and saving the identity never overwrite each other.
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { isHeaderSafe } from '../../lib/email-transport.js';

export const FROM_NAME_MAX = 120;
const ADDRESS_MAX = 254;

const EmailAddress = z.string().email().max(ADDRESS_MAX);

export interface SenderIdentity {
  fromName: string | null;
  replyTo: string | null;
  supportEmail: string | null;
}

/** A patch: a string sets the field, `null` or `''` clears it, absent leaves it. */
export type SenderIdentityPatch = {
  [K in keyof SenderIdentity]?: string | null | undefined;
};

/**
 * Refuse a display name that could break out of the From header.
 *
 * @example
 * ```ts
 * assertFromName('Acme Support');           // ok
 * assertFromName('Acme\r\nBcc: x@evil.test'); // throws EMAIL_FROM_NAME_INVALID
 * ```
 */
export function assertFromName(name: string): void {
  if (name.length > FROM_NAME_MAX || !isHeaderSafe(name)) {
    throw new RekeyError({
      statusCode: 400,
      code: 'EMAIL_FROM_NAME_INVALID',
      message: `fromName must be at most ${FROM_NAME_MAX} characters with no line breaks or other control characters.`,
      fix: 'Send a single-line display name such as "Acme Support", or null to clear it.',
    });
  }
}

function assertAddress(value: string, code: string, field: string): void {
  if (!isHeaderSafe(value) || !EmailAddress.safeParse(value).success) {
    throw new RekeyError({
      statusCode: 400,
      code,
      message: `${field} must be a single email address.`,
      fix: `Send ${field} as an address such as "help@yourcompany.com", or null to clear it.`,
    });
  }
}

/** Trimmed patch with every value checked, and `''` turned into `null`. */
function validated(patch: SenderIdentityPatch): Partial<Record<keyof SenderIdentity, string | null>> {
  const out: Partial<Record<keyof SenderIdentity, string | null>> = {};
  for (const key of ['fromName', 'replyTo', 'supportEmail'] as const) {
    const raw = patch[key];
    if (raw === undefined) continue;
    const value = raw === null ? '' : raw.trim();
    if (value === '') {
      out[key] = null;
      continue;
    }
    if (key === 'fromName') assertFromName(value);
    if (key === 'replyTo') assertAddress(value, 'EMAIL_REPLY_TO_INVALID', 'replyTo');
    if (key === 'supportEmail') assertAddress(value, 'EMAIL_SUPPORT_EMAIL_INVALID', 'supportEmail');
    out[key] = value;
  }
  return out;
}

/**
 * Merge keys into `emailConfig` in one statement, so two writers touching
 * different keys (the credentials save and the sender save) cannot lose each
 * other's change to a read-modify-write race. `null` removes a key.
 */
export async function mergeEmailConfig(
  applicationId: string,
  changes: Record<string, string | null>,
  extra: Prisma.Sql = Prisma.empty,
): Promise<void> {
  const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null));
  const removed = Object.keys(changes).filter((k) => changes[k] === null);
  await prisma.$executeRaw`
    UPDATE applications
       SET email_config = (
             CASE WHEN jsonb_typeof(email_config) = 'object' THEN email_config ELSE '{}'::jsonb END
             || ${JSON.stringify(set)}::jsonb
           ) - ${removed}::text[],
           updated_at = now()
           ${extra}
     WHERE id = ${applicationId}`;
}

/**
 * Apply a sender-identity patch and return the identity now stored.
 *
 * @example
 * ```ts
 * await updateSenderIdentity(app.id, { replyTo: 'help@acme.com', fromName: null });
 * ```
 */
export async function updateSenderIdentity(
  applicationId: string,
  patch: SenderIdentityPatch,
): Promise<SenderIdentity> {
  const changes = validated(patch);
  if (Object.keys(changes).length === 0) {
    throw new RekeyError({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Nothing to update.',
      fix: 'Send at least one of fromName, replyTo or supportEmail.',
    });
  }
  await mergeEmailConfig(applicationId, changes);
  const row = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    select: { emailConfig: true },
  });
  const cfg = (row.emailConfig ?? {}) as Partial<Record<keyof SenderIdentity, string>>;
  return {
    fromName: cfg.fromName ?? null,
    replyTo: cfg.replyTo ?? null,
    supportEmail: cfg.supportEmail ?? null,
  };
}
