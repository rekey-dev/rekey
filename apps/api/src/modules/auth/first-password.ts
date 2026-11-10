/**
 * A first password for an account that has none: one that joined by emailed
 * link or a social provider.
 *
 * A password outlives every session, so setting one from a stolen session
 * would be a takeover the owner cannot end by signing out. The caller proves
 * the mailbox with a code emailed to the verified address (`emailed-code.ts`):
 * the session alone does not carry it, and a recent sign-in is a property of
 * the same stolen token. Like a password change, it then ends every session,
 * the caller's included.
 */

import type { Application } from '@prisma/client';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { hashPassword } from '../../lib/passwords.js';
import { lockEndUserCredentials } from '../../lib/session-basis.js';
import { revokeAllForEndUser } from '../../lib/refresh-tokens.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';
import { emailService } from '../email/email.service.js';
import { ensurePasswordMethodEnabled, ensurePasswordNotBreached } from './auth.service.js';
import { assertEmailedCode } from './emailed-code.js';

function passwordAlreadySet(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'PASSWORD_ALREADY_SET',
    message: 'This account already has a password.',
    fix: 'Change it with POST /api/v1/auth/change-password, which takes the current password, or reset it with POST /api/v1/auth/forgot-password.',
  });
}

/**
 * The refusals that do not depend on the new password, so a code is not
 * emailed for a password that could never be set.
 *
 * @example
 *   await assertFirstPasswordAllowed(application, endUserId);
 */
export async function assertFirstPasswordAllowed(application: Application, endUserId: string): Promise<void> {
  ensurePasswordMethodEnabled(application);
  const row = await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId }, select: { passwordHash: true } });
  if (row.passwordHash) throw passwordAlreadySet();
}

/**
 * @example
 *   await setFirstPassword({ application, endUserId, newPassword, emailCode: '048213' });
 */
export async function setFirstPassword(input: {
  application: Application;
  endUserId: string;
  newPassword: string;
  emailCode: string;
}): Promise<{ ok: true }> {
  ensurePasswordMethodEnabled(input.application);
  const config = AuthConfigSchema.parse(input.application.authConfig);
  if (input.newPassword.length < config.passwordMinLength) {
    throw new RekeyError({
      statusCode: 400,
      code: 'PASSWORD_TOO_SHORT',
      message: `Password must be at least ${config.passwordMinLength} characters.`,
      fix: `Send a password of length >= ${config.passwordMinLength}.`,
    });
  }
  const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: input.endUserId } });
  // Every refusal that is not about the code comes before it is spent, so a
  // breached password does not cost the customer their code.
  if (endUser.passwordHash) throw passwordAlreadySet();
  await ensurePasswordNotBreached(input.application, input.newPassword);
  await assertEmailedCode(endUser.id, 'set_password', input.emailCode);

  const newHash = await hashPassword(input.newPassword);
  const deliveryIds = await prisma.$transaction(async (tx) => {
    const row = await lockEndUserCredentials(tx, endUser.id);
    // Two requests racing on one code cannot both get here, but a reset or a
    // claim landing in between could have set a password since the read.
    if (row?.passwordHash) throw passwordAlreadySet();
    await tx.endUser.update({ where: { id: endUser.id }, data: { passwordHash: newHash } });
    await revokeAllForEndUser(endUser.id, tx);
    return enqueueEvent(tx, {
      applicationId: input.application.id,
      type: 'password.changed',
      data: { userId: endUser.id, email: endUser.email, via: 'set' },
    });
  });
  kickDeliveries(deliveryIds);
  void emailService
    .dispatch({
      application: input.application,
      eventKey: 'password_changed',
      to: endUser.email,
      variables: { userEmail: endUser.email, changedAtIso: new Date().toISOString() },
    })
    .catch(() => undefined);
  return { ok: true };
}
