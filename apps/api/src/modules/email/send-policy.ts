/**
 * Whether an email may go to an address: the one rule every send path asks.
 *
 * The built-in dispatch, both test sends and the custom send each used to
 * carry their own copy of this check, and the copies drifted: a one-click
 * unsubscribe from a newsletter ended up blocking password resets, because the
 * built-in copy treated every suppression row as absolute.
 */

import type { Application } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * `auth`: the built-in emails (verification, reset, magic link and the rest).
 * `critical` / `notification`: a custom template's category.
 */
export type SendKind = 'auth' | 'critical' | 'notification';

export type BlockReason = 'application_disabled' | 'event_disabled' | 'suppressed_address' | 'unsubscribed';

export interface Blocked {
  reason: BlockReason;
  /** Recorded on the email log row and shown in the Delivery view. */
  text: string;
  /** The suppression row's own reason (bounce, complaint, manual, unsubscribe). */
  suppressionReason?: string;
}

export const BLOCK_TEXT: Record<BlockReason, string> = {
  application_disabled: 'All email is switched off for this Application.',
  event_disabled: 'This email event is switched off for this Application.',
  suppressed_address: 'This address is on the Application suppression list.',
  unsubscribed: 'This address unsubscribed from notification emails.',
};

/** True when a suppression row with this category stops mail of this kind. */
export function suppressionCovers(category: string | null, kind: SendKind): boolean {
  return category === null || category === kind;
}

/**
 * Null when the send may go out, otherwise why not. Broadest gate first.
 *
 * `testSend` skips the master switch and the per-event switch, because proving
 * a transport works before switching mail back on is what a test send is for.
 * It never skips the suppression list: mailing an address that bounced or
 * complained is how a sending domain gets blocked, test or not.
 *
 * @example
 * ```ts
 * const blocked = await sendableTo(application, 'a@example.com', 'auth', { eventKey: 'password_reset' });
 * if (blocked) return; // logged as suppressed by the caller
 * ```
 */
export async function sendableTo(
  application: Application,
  to: string,
  kind: SendKind,
  opts: { eventKey?: string; testSend?: boolean } = {},
): Promise<Blocked | null> {
  if (!opts.testSend) {
    if (application.emailsEnabled === false) {
      return { reason: 'application_disabled', text: BLOCK_TEXT.application_disabled };
    }
    if (opts.eventKey !== undefined) {
      const setting = await prisma.emailEventSetting.findUnique({
        where: { applicationId_eventKey: { applicationId: application.id, eventKey: opts.eventKey } },
        select: { enabled: true },
      });
      // A missing row means enabled.
      if (setting !== null && setting.enabled === false) {
        return { reason: 'event_disabled', text: BLOCK_TEXT.event_disabled };
      }
    }
  }
  const row = await prisma.emailSuppression.findUnique({
    where: { applicationId_address: { applicationId: application.id, address: to.trim().toLowerCase() } },
    select: { reason: true, category: true },
  });
  if (row === null || !suppressionCovers(row.category, kind)) return null;
  const reason: BlockReason = row.category === null ? 'suppressed_address' : 'unsubscribed';
  return { reason, text: BLOCK_TEXT[reason], suppressionReason: row.reason };
}
