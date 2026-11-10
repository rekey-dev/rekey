/**
 * Six-digit codes emailed to an account's verified address, proving the
 * signed-in caller can read that mailbox. A session alone is a bearer
 * credential; the code is what a stolen session does not carry. Used where an
 * account has no password and no authenticator to prove itself with: setting
 * a first password, and deleting the account.
 *
 * One live code per (account, purpose), ten minutes, single use, and five
 * wrong tries end it. Stored as an HMAC under a server secret, so a dump of
 * the store cannot be brute-forced back to the six digits offline. Redis in
 * production; an in-process map when there is no Redis client (tests).
 */

import { createHmac, randomInt } from 'node:crypto';
import type { Application } from '@prisma/client';
import type { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { dependencyUnavailablePayload, RekeyError } from '../../lib/error.js';
import { getRedis } from '../../lib/redis.js';
import { prisma } from '../../lib/prisma.js';
import { emailService } from '../email/email.service.js';
import { applicationEmailScope, authEmailCappedError, reserveAuthEmail } from '../email/auth-email-caps.js';
import { assertVerifiedForCredential } from './user-lifecycle.js';

export const EMAILED_CODE_PURPOSES = ['set_password', 'delete_account'] as const;
export type EmailedCodePurpose = (typeof EMAILED_CODE_PURPOSES)[number];

/** What the code lets the customer do, as the email and errors say it. */
const PURPOSE_ACTION: Record<EmailedCodePurpose, string> = {
  set_password: 'set a password',
  delete_account: 'delete your account',
};

const CODE_TTL_SECONDS = 10 * 60;
const MAX_WRONG_TRIES = 5;
const PREFIX = 'eu:emailed-code:';

/**
 * Compare and spend in one step: 1 accepted (and deleted), 0 wrong (counted,
 * deleted at the limit), -1 no live code.
 */
const SPEND_SCRIPT = `
local stored = redis.call('HGET', KEYS[1], 'mac')
if not stored then return -1 end
if stored == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
if redis.call('HINCRBY', KEYS[1], 'wrong', 1) >= tonumber(ARGV[2]) then redis.call('DEL', KEYS[1]) end
return 0
`;

const memory = new Map<string, { mac: string; wrong: number; expiresAt: number }>();

function keyFor(endUserId: string, purpose: EmailedCodePurpose): string {
  return `${PREFIX}${purpose}:${endUserId}`;
}

function macOf(endUserId: string, purpose: EmailedCodePurpose, code: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`emailed-code:${purpose}:${endUserId}:${code}`).digest('hex');
}

/** Redis, or null for the in-process fallback. Production without Redis is refused: each replica would hold its own codes. */
function store(): Redis | null {
  const redis = getRedis();
  if (!redis && env.NODE_ENV === 'production') throw new RekeyError(dependencyUnavailablePayload('redis'));
  return redis;
}

async function failClosed<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof RekeyError) throw err;
    throw new RekeyError(dependencyUnavailablePayload('redis'));
  }
}

/**
 * Mint a code, replacing any live one for the same purpose.
 *
 * @example
 *   const code = await issueEmailedCode(user.id, 'set_password'); // '048213'
 */
export async function issueEmailedCode(
  endUserId: string,
  purpose: EmailedCodePurpose,
  redis: Redis | null = store(),
): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const mac = macOf(endUserId, purpose, code);
  const key = keyFor(endUserId, purpose);
  if (redis) {
    await failClosed(() => redis.multi().del(key).hset(key, 'mac', mac, 'wrong', '0').expire(key, CODE_TTL_SECONDS).exec());
  } else {
    memory.set(key, { mac, wrong: 0, expiresAt: Date.now() + CODE_TTL_SECONDS * 1000 });
  }
  return code;
}

/** Remove a code that was never delivered. */
export async function discardEmailedCode(
  endUserId: string,
  purpose: EmailedCodePurpose,
  redis: Redis | null = store(),
): Promise<void> {
  const key = keyFor(endUserId, purpose);
  if (redis) await failClosed(() => redis.del(key));
  else memory.delete(key);
}

/**
 * Spend a code. True only for the live code; a wrong one counts toward its
 * five tries.
 *
 * @example
 *   if (!(await spendEmailedCode(user.id, 'delete_account', body.emailCode))) refuse();
 */
export async function spendEmailedCode(
  endUserId: string,
  purpose: EmailedCodePurpose,
  code: string,
  redis: Redis | null = store(),
): Promise<boolean> {
  const key = keyFor(endUserId, purpose);
  const mac = macOf(endUserId, purpose, code.trim());
  if (redis) {
    const result = await failClosed(() => redis.eval(SPEND_SCRIPT, 1, key, mac, String(MAX_WRONG_TRIES)));
    return result === 1;
  }
  const entry = memory.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return false;
  }
  if (entry.mac === mac) {
    memory.delete(key);
    return true;
  }
  entry.wrong += 1;
  if (entry.wrong >= MAX_WRONG_TRIES) memory.delete(key);
  return false;
}

/**
 * Throw EMAIL_CODE_INVALID unless `code` is this account's live code for
 * `purpose`. Spends it on success.
 */
export async function assertEmailedCode(endUserId: string, purpose: EmailedCodePurpose, code: string): Promise<void> {
  if (await spendEmailedCode(endUserId, purpose, code)) return;
  throw new RekeyError({
    statusCode: 401,
    code: 'EMAIL_CODE_INVALID',
    message: `That emailed code is wrong or no longer works, so you cannot ${PURPOSE_ACTION[purpose]} with it.`,
    fix: `Send \`emailCode\` with the code from the most recent email, or ask for a new one with POST /api/v1/auth/email-code { "purpose": "${purpose}" }. A code works once, for 10 minutes, and five wrong tries end it.`,
  });
}

/**
 * Email the signed-in user a code for `purpose`, to their verified address.
 * Counted against the per-recipient auth email cap.
 */
export async function sendEmailedCode(args: {
  application: Application;
  endUserId: string;
  purpose: EmailedCodePurpose;
}): Promise<{ sent: true; expiresAt: string }> {
  const user = await prisma.endUser.findUniqueOrThrow({ where: { id: args.endUserId } });
  // A code to an address nobody confirmed proves nothing about the account.
  assertVerifiedForCredential(user, `get an emailed code to ${PURPOSE_ACTION[args.purpose]}`);
  const reserved = await reserveAuthEmail(applicationEmailScope(args.application), user.email);
  if (!reserved.allowed) throw authEmailCappedError(reserved.retryAfterSeconds);
  const code = await issueEmailedCode(user.id, args.purpose);
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();
  const outcome = await emailService.dispatch({
    application: args.application,
    eventKey: 'account_code',
    to: user.email,
    variables: { userEmail: user.email, code, action: PURPOSE_ACTION[args.purpose], expiresAtIso: expiresAt },
  });
  if (outcome.kind !== 'sent') {
    await discardEmailedCode(user.id, args.purpose);
    await reserved.unsent();
    // Never handed back in the response, unlike a no-transport reset token:
    // the code exists to prove the mailbox, and the caller is the one being
    // asked to prove it.
    throw new RekeyError({
      statusCode: 503,
      code: 'EMAIL_CODE_NOT_SENT',
      message: 'The code could not be emailed, so nothing was sent.',
      fix: 'The Application has no working email delivery for this mail: check its email settings in the panel (Email), then ask for a new code.',
    });
  }
  return { sent: true, expiresAt };
}

/**
 * Whether the account can prove itself with something it owns: a password or
 * a confirmed authenticator. Only an account with neither deletes itself with
 * an emailed code; one with either uses that, a stronger proof than a mailbox.
 */
export async function hasPasswordOrAuthenticator(endUserId: string): Promise<boolean> {
  const [user, mfa] = await Promise.all([
    prisma.endUser.findUniqueOrThrow({ where: { id: endUserId }, select: { passwordHash: true } }),
    prisma.mfaCredential.findUnique({ where: { endUserId }, select: { enrolledAt: true } }),
  ]);
  return Boolean(user.passwordHash) || Boolean(mfa?.enrolledAt);
}

export function __resetForTests(): void {
  memory.clear();
}
