/**
 * Operator (TenantUser) auth service.
 *
 * Mirrors the EndUser auth shape (`modules/auth/auth.service.ts`) but
 * writes to `tenant_users` and produces tenant-scoped JWTs.
 *
 * Key behavioural differences from end-user auth:
 *   - sign-up creates a Tenant + an OWNER membership atomically. The first
 *     person to sign up owns their workspace; team-mates join via invite.
 *   - sign-in returns the user's full memberships list. The caller picks an
 *     active workspace (defaults to the OLDEST, `loadMemberships` orders
 *     `createdAt: 'asc'` and callers take `[0]`, so it is the workspace you
 *     joined first, which for most operators is the one they created) and we mint
 *     tokens scoped to that tenant.
 *   - refresh / sign-out / password-reset / change-password mirror the
 *     end-user surface 1:1; the only change is which JWT shape we issue.
 */

import type { Tenant, TenantRefreshToken, TenantRole, TenantUser } from '@prisma/client';
import { expandScopes, type Scope } from '../../lib/operator-scopes.js';
import { invalidateOperatorAuth } from '../../lib/operator-auth-cache.js';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { hashPassword, verifyPassword, verifyPasswordOrDecoy } from '../../lib/passwords.js';
import { joinOrCreateWorkspace } from './workspace-join.js';
import {
  assertNotLocked,
  registerFailure,
  clearFailures,
  operatorLoginLockScope,
  LOGIN_POLICY,
} from '../../lib/brute-force.js';
import {
  issueTenantAccessToken,
  issueTenantMfaChallengeToken,
  verifyTenantMfaChallengeToken,
} from '../../lib/tenant-jwt.js';
import { tenantMfaService } from '../tenant-mfa/tenant-mfa.service.js';
import {
  claimMfaChallenge,
  isMfaChallengeSpent,
  mfaChallengeUsedError,
  mfaCodeReusedError,
} from '../../lib/mfa-replay.js';
import {
  issueTenantRefreshToken,
  lookupTenantRefreshToken,
  rotateTenantRefreshToken,
  revokeEveryOperatorSession,
  revokeTenantRefreshToken,
  revokeAllTenantRefreshTokensForUser,
  listActiveTenantSessions,
  revokeSessionForTenantUser,
  type TenantSessionSummary,
} from '../../lib/tenant-refresh-tokens.js';
import {
  issueTenantResetToken,
  lookupTenantResetToken,
  consumeTenantResetToken,
} from '../../lib/tenant-password-reset.js';
import {
  issueTenantMagicLinkToken,
  lookupTenantMagicLinkToken,
  consumeTenantMagicLinkToken,
} from '../../lib/tenant-magic-link.js';
import { panelBaseUrl } from '../../lib/panel-url.js';
import { emailService } from '../email/email.service.js';
import { recordAuthEmailDeliveryFailure } from '../../lib/email-transport.js';
import { checkPasswordBreached } from '../../lib/breached-password.js';
import { env } from '../../config/env.js';
import { judgeReplay, REFRESH_REUSE_WINDOW_MS } from '../../lib/refresh-reuse-window.js';

/**
 * Whether to echo raw reset / magic-link tokens back in API responses.
 *
 * Local-development convenience only: it lets the panel render a working
 * reset link with no mail transport configured. Deny-by-default and gated on
 * an explicit flag rather than `NODE_ENV`, because NODE_ENV defaults to
 * 'development', keying off it would fail OPEN for anyone running the API
 * outside our Docker image. `config/env.ts` refuses to boot when the flag is
 * set with NODE_ENV=production.
 */
function echoAuthTokensInDev(): boolean {
  // The test env is not a deployment: the integration suites drive these flows
  // end-to-end (request -> consume the token -> assert the session), so they
  // need the raw value. NODE_ENV='test' is set by vitest, never by a server.
  if (env.NODE_ENV === 'test') return true;
  return env.NODE_ENV === 'development' && process.env.REKEY_DEV_ECHO_AUTH_TOKENS === 'true';
}
import {
  assertBoundEmail,
  consumeSignupInvite,
  resolveSignupInvite,
} from './operator-signup-policy.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import {
  authEmailCappedError,
  mayMailUnattended,
  OPERATOR_EMAIL_SCOPE,
  reserveAuthEmail,
} from '../email/auth-email-caps.js';
import {
  issueTenantEmailVerificationToken,
  lookupTenantEmailVerificationToken,
} from '../../lib/tenant-email-verification.js';
import { boundStamp, lockOperatorCredentials, sessionBasis, type SessionBasis } from '../../lib/session-basis.js';
import { unanchoredTokenEnded } from '../../lib/session-stamp.js';
import { operatorCredentialSuperseded, operatorSessionEndedMeanwhile } from '../../lib/session-refusals.js';
import { fromEndedGeneration } from '../../lib/refresh-tokens.js';
import {
  claimUnverifiedOperator,
  reviewHasFindings,
  operatorConfirmation,
  operatorConfirmationFix,
  promoteOperatorAfterMfa,
  sendOperatorClaimedEmail,
  type OperatorMailboxProof,
} from './operator-claim.js';

/**
 * Run a claim for an operator who just proved the mailbox, and send the
 * notice it owes. `mailboxProven` is true when an enrolled second factor held
 * the claim back, for the MFA challenge to carry forward.
 */
async function claimOperatorOnProof(
  user: TenantUser,
  provenBy: OperatorMailboxProof,
  notice: 'mail' | 'silent' = 'mail',
): Promise<{ user: TenantUser; mailboxProven: boolean }> {
  if (user.emailVerified) return { user, mailboxProven: false };
  const claim = await prisma.$transaction((tx) => claimUnverifiedOperator(tx, user, provenBy));
  if (claim.kind === 'claimed') {
    invalidateOperatorAuth(user.id);
    // Owed when something that signs in was removed, or when the workspace
    // holds people or credentials the owner should look over.
    if (notice === 'mail' && (claim.signInMethodsRemoved || reviewHasFindings(claim.review))) {
      sendOperatorClaimedEmail(claim.user, claim.review);
    }
    return { user: claim.user, mailboxProven: false };
  }
  return {
    user: await prisma.tenantUser.findUniqueOrThrow({ where: { id: user.id } }),
    mailboxProven: claim.kind === 'held_for_mfa',
  };
}

/**
 * Mint a confirmation token and mail its link. The raw token comes back only
 * where tokens are echoed and the mail did not go out.
 */
async function mailOperatorConfirmation(
  user: Pick<TenantUser, 'id' | 'email'>,
  tenantId: string | null,
): Promise<{ emailSent: boolean; verificationToken: string | null }> {
  const issued = await issueTenantEmailVerificationToken(user.id, user.email);
  const base = panelBaseUrl();
  if (base) {
    const outcome = await emailService.dispatchSystem({
      eventKey: 'operator_email_verification',
      to: user.email,
      variables: {
        userEmail: user.email,
        verifyUrl: `${base}/verify-email?token=${encodeURIComponent(issued.raw)}`,
        expiresAtIso: issued.record.expiresAt.toISOString(),
      },
      tenantId,
    });
    if (outcome.kind === 'sent') return { emailSent: true, verificationToken: null };
    if (outcome.kind === 'error') {
      void recordAuthEmailDeliveryFailure({
        applicationId: null,
        tenantId,
        eventKey: 'operator_email_verification',
        reason: outcome.message,
      });
    }
  }
  return { emailSent: false, verificationToken: echoAuthTokensInDev() ? issued.raw : null };
}

const PASSWORD_MIN_LENGTH = 8;

/**
 * The only rule an operator password had to satisfy, everywhere, was
 * `length >= 8`, so `password` was accepted. Meanwhile the product ships HIBP
 * k-anonymity breach checking for its CUSTOMERS' end-users
 * (`lib/breached-password.ts`, wired into `auth.service.ensurePasswordNotBreached`)
 * and never wired it to its own operators, the accounts that reach every
 * workspace, every end-user and every decrypted billing credential in the
 * deployment. Holding the more privileged account to the weaker standard is
 * backwards.
 *
 * Applies to sign-up, reset and change alike, so there is no path that sets an
 * operator password without passing through this.
 *
 * No availability cost: `checkPasswordBreached` has a 1.5s timeout and fails
 * OPEN, an unreachable HIBP lets the password through rather than blocking
 * sign-up. `HIBP_BREACH_CHECK_DISABLED` turns it off deployment-wide, the same
 * switch the end-user path honours. There is deliberately no per-operator
 * opt-out: end-users get one because the Application owner is accountable for
 * their own users' experience, and nobody is in that position for operators.
 */
async function assertOperatorPasswordAcceptable(password: string): Promise<void> {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new RekeyError({
      statusCode: 400,
      code: 'PASSWORD_TOO_SHORT',
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
      fix: `Send a password of length >= ${PASSWORD_MIN_LENGTH}.`,
    });
  }
  if (env.HIBP_BREACH_CHECK_DISABLED) return;
  const result = await checkPasswordBreached(password);
  if (result.breached) {
    throw new RekeyError({
      statusCode: 400,
      code: 'PASSWORD_BREACHED',
      message: `This password has been seen in ${result.count.toLocaleString()} known breach corpora and cannot be used.`,
      fix: "Choose a password you haven't used anywhere else. A password manager generating a long random string is the easiest path.",
    });
  }
}

/**
 * The ONE body `/tenant/auth/forgot-password` returns.
 *
 * Both operator credential-send endpoints used to report what actually
 * happened, `delivered: false` for an address with no operator account,
 * `delivered: true` for one that has, which is a complete account-existence
 * oracle on an unauthenticated endpoint, for the accounts that reach every
 * workspace and every decrypted billing credential in the deployment.
 *
 * The end-user surface solved this first and this is the same shape as its
 * `PUBLISHABLE_SEND_RESPONSE`: unknown address, real send, and broken transport
 * are byte-identical to the caller, and the real outcome is recorded in the
 * security log instead. There is no secret-key tier here to exempt, the panel
 * is first-party, so every caller of these two routes is a browser.
 *
 * The only path that still varies is the dev token echo
 * (`echoAuthTokensInDev`), which exists so a self-hoster with no mail transport
 * can complete the flow; `config/env.ts` refuses to boot with it set in
 * production.
 */
const CONSTANT_RESET_RESPONSE = { delivered: true, resetToken: null } as const;

/** The magic-link twin of `CONSTANT_RESET_RESPONSE`. Same reasoning. */
const CONSTANT_MAGIC_LINK_RESPONSE = { delivered: true, token: null } as const;

export type PublicTenantUser = Omit<TenantUser, 'passwordHash' | 'sessionsInvalidBefore'>;

function redact(user: TenantUser): PublicTenantUser {
  const { passwordHash, sessionsInvalidBefore, ...rest } = user;
  return rest;
}

/**
 * The workspace a failed sign-in is attributed to.
 *
 * An operator sign-in happens BEFORE a workspace is chosen, so there is no
 * `tenantId` on the request, and every reader of `security_events` is
 * tenant-scoped (`listSecurityEvents` takes a required `tenantId`, the operator
 * MCP tool filters on one, the panel page is inside a workspace). A row written
 * with `tenantId: null` is therefore a row nobody can ever see, which is the
 * same as not writing it.
 *
 * So we resolve the workspace the way sign-in itself would have: the OLDEST
 * membership, which is what `loadMemberships()[0]` selects as the active one.
 * The failure lands in the log of the workspace the operator was trying to
 * reach.
 *
 * Returns null only for an operator with no memberships at all, nothing can
 * be attributed, and sign-in would have refused them anyway.
 */
async function primaryTenantId(tenantUserId: string): Promise<string | null> {
  const membership = await prisma.tenantMembership.findFirst({
    where: { tenantUserId },
    orderBy: { createdAt: 'asc' },
    select: { tenantId: true },
  });
  return membership?.tenantId ?? null;
}

/** Starter workspace name for an OAuth operator (no workspace-name input). */
function deriveWorkspaceName(name: string | undefined, email: string): string {
  const base = (name && name.trim()) || email.split('@')[0] || 'My';
  return `${base}'s Workspace`;
}

export interface MembershipSummary {
  tenantId: string;
  tenantName: string;
  role: TenantRole;
  /**
   * The member's RESOLVED scopes in this workspace, lineage applied, reads
   * implied, or `null` when unrestricted (OWNER, ADMIN, and every member
   * nobody has restricted). What the panel renders navigation from.
   */
  scopes: Scope[] | null;
}

export interface AuthSessionResult {
  user: PublicTenantUser;
  /** Memberships the user has at sign-in time. UI uses this to populate the workspace switcher. */
  memberships: MembershipSummary[];
  /** Active workspace this token pair is scoped to. */
  activeTenantId: string;
  activeRole: TenantRole;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * Operator sign-in MFA challenge, primary factor passed but MFA enrolled.
 * Mirror of the end-user `MfaChallengeResult`. The challenge token holds
 * an unauthenticated identity and can only be exchanged via
 * `/tenant/auth/mfa-verify` for a real session.
 */
export interface TenantMfaChallengeResult {
  mfaRequired: true;
  user: PublicTenantUser;
  mfaChallengeToken: string;
  mfaChallengeExpiresAt: Date;
}

export type TenantSignInOutcome =
  | ({ mfaRequired: false } & AuthSessionResult)
  | TenantMfaChallengeResult;

async function loadMemberships(tenantUserId: string): Promise<MembershipSummary[]> {
  const rows = await prisma.tenantMembership.findMany({
    where: { tenantUserId },
    include: { tenant: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    tenantId: r.tenantId,
    tenantName: r.tenant.name,
    role: r.role,
    scopes:
      r.role === 'MEMBER' && r.scopesRestricted ? [...expandScopes(r.scopes)].sort() : null,
  }));
}

export interface TenantDeviceContext {
  userAgent?: string | null;
  ip?: string | null;
}

/** The answer to a password that is wrong, or that stopped being the account's while it was checked. */
function invalidCredentials(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'INVALID_CREDENTIALS',
    message: 'Email or password is incorrect.',
    fix: 'Double-check the credentials. If you signed up via OAuth, password sign-in will not work for you.',
  });
}

function refreshTokenRevoked(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'REFRESH_TOKEN_REVOKED',
    message: 'This session was revoked.',
    fix: 'Sign in again. Either this session was signed out, or a reuse of one of its tokens elsewhere revoked the whole family.',
  });
}

async function issueSession(
  user: TenantUser,
  activeTenantId: string,
  activeRole: TenantRole,
  memberships: MembershipSummary[],
  device: TenantDeviceContext | undefined,
  basis: SessionBasis,
): Promise<AuthSessionResult> {
  // Refresh row first: its session id rides on the access token as `sid`.
  const refresh = await issueTenantRefreshToken(
    user.id,
    { userAgent: device?.userAgent ?? null, ip: device?.ip ?? null, activeTenantId },
    basis,
  );
  const access = issueTenantAccessToken(user.id, activeTenantId, activeRole, {
    sessionId: refresh.record.sessionId,
  });
  return {
    user: redact(user),
    memberships,
    activeTenantId,
    activeRole,
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.raw,
    refreshTokenExpiresAt: refresh.record.expiresAt,
  };
}

/**
 * Answer a replay of a ROTATED operator refresh token. Always throws. The
 * operator twin of `refuseRotatedReplay` in auth.service.ts, same rule (see
 * lib/refresh-reuse-window.ts): inside the reuse window, while the successor
 * is unused, `REFRESH_TOKEN_RACED` and nothing revoked; otherwise every
 * session the operator has is revoked. Operator chains carry no device
 * binding, so timing and the successor's state are the whole test.
 *
 * The event names the workspace the session was in (`replayEventTenant`), so
 * it lands in a feed an owner of THAT workspace can read; an operator with no
 * membership left gets a row with no workspace, which the super-admin log
 * still holds.
 */
/**
 * The workspace a replay's security event is filed under: the one the session
 * was active in (`activeTenantId` on the refresh row, the same choice the
 * refresh itself makes), while the operator is still a member there. Else the
 * oldest membership, as before, which covers a row from before the column
 * existed and an operator since removed from that workspace.
 *
 * The event carries the replaying request's IP and user agent, and every owner
 * of the workspace it names can read it. Filing it under the OLDEST
 * membership showed an operator's session activity in some other workspace to
 * that workspace's owner, who has nothing to do with the session.
 */
async function replayEventTenant(presented: TenantRefreshToken): Promise<string | null> {
  if (presented.activeTenantId) {
    const active = await prisma.tenantMembership.findFirst({
      where: { tenantUserId: presented.tenantUserId, tenantId: presented.activeTenantId },
      select: { tenantId: true },
    });
    if (active) return active.tenantId;
  }
  const home = await prisma.tenantMembership.findFirst({
    where: { tenantUserId: presented.tenantUserId },
    orderBy: { createdAt: 'asc' },
    select: { tenantId: true },
  });
  return home?.tenantId ?? null;
}

async function refuseRotatedTenantReplay(
  presented: TenantRefreshToken,
  device: TenantDeviceContext | undefined,
  via: 'lookup' | 'rotation_race',
): Promise<never> {
  // A token from before the last time every session was ended cannot show
  // that a session the operator has now was stolen. See `refuseRotatedReplay`
  // in auth.service.ts.
  const owner = await prisma.tenantUser.findUnique({
    where: { id: presented.tenantUserId },
    select: { sessionsInvalidBefore: true },
  });
  if (fromEndedGeneration(presented, owner?.sessionsInvalidBefore)) throw refreshTokenRevoked();
  const successor = presented.replacedById
    ? await prisma.tenantRefreshToken.findUnique({ where: { id: presented.replacedById } })
    : null;
  const verdict = judgeReplay(presented, successor, new Date());
  const trail = {
    actorType: 'operator' as const,
    actorId: presented.tenantUserId,
    tenantId: await replayEventTenant(presented),
    ip: device?.ip ?? null,
    userAgent: device?.userAgent ? device.userAgent.slice(0, 512) : null,
  };
  if (verdict.kind === 'raced') {
    await recordSecurityEvent({
      ...trail,
      type: 'operator.refresh_token_raced',
      metadata: {
        sessionId: presented.sessionId,
        presentedTokenId: presented.id,
        successorTokenId: presented.replacedById,
        msSinceRotation: verdict.msSinceRotation,
        windowSeconds: REFRESH_REUSE_WINDOW_MS / 1000,
        via,
      },
    });
    throw new RekeyError({
      statusCode: 401,
      code: 'REFRESH_TOKEN_RACED',
      message:
        'This refresh token was rotated moments ago by another request. No session was revoked.',
      fix: 'Do not retry with this token. Use the refresh token the other request received (re-read the cookie); if this client never got it, sign in again. Replaying this token later revokes every session.',
    });
  }
  const revokedCount = await revokeAllTenantRefreshTokensForUser(presented.tenantUserId);
  await recordSecurityEvent({
    ...trail,
    type: 'operator.refresh_token_reused',
    metadata: {
      sessionId: presented.sessionId,
      presentedTokenId: presented.id,
      reason: verdict.reason,
      revokedCount,
      via,
    },
  });
  throw new RekeyError({
    statusCode: 401,
    code: 'REFRESH_TOKEN_REUSED',
    message:
      via === 'lookup'
        ? 'Refresh token has already been used. All sessions for this operator have been revoked as a precaution.'
        : 'Refresh token rotation lost a race with another request. All sessions revoked as a precaution.',
    fix:
      via === 'lookup'
        ? 'A used refresh token cannot be replayed. Sign in again to obtain a fresh session.'
        : 'Sign in again to obtain a fresh session.',
  });
}

export const tenantAuthService = {
  async listSessions(
    tenantUserId: string,
    opts: { take?: number; skip?: number } = {},
  ): Promise<{ items: TenantSessionSummary[]; total: number }> {
    return listActiveTenantSessions(tenantUserId, opts);
  },

  async revokeSession(args: {
    tenantUserId: string;
    sessionId: string;
  }): Promise<{ revoked: boolean }> {
    const revoked = await revokeSessionForTenantUser(args.tenantUserId, args.sessionId);
    return { revoked };
  },

  /**
   * Self-serve sign-up. Atomically creates a TenantUser + a Tenant + an
   * OWNER Membership, then issues a session scoped to the new workspace.
   * With a workspace-bound invite key it joins that workspace at the key's
   * role instead, and `workspaceName` is not used.
   *
   * If the email already exists, returns EMAIL_ALREADY_EXISTS, sign-in
   * is the right action there.
   */
  async signUpAndCreateWorkspace(input: {
    email: string;
    password: string;
    name?: string | undefined;
    /** Required unless `inviteKey` is bound to a workspace. */
    workspaceName?: string | undefined;
    /** Single-use invite key, required when OPERATOR_SIGNUP_MODE='invite'. */
    inviteKey?: string | undefined;
    device?: TenantDeviceContext;
  }): Promise<AuthSessionResult> {
    await assertOperatorPasswordAcceptable(input.password);
    // Enforce OPERATOR_SIGNUP_MODE before doing any work. Validation only,
    // the key is consumed atomically inside the creation transaction below, so
    // a later failure (e.g. duplicate email) does not burn it.
    const invite = await resolveSignupInvite(input.inviteKey);
    if (invite?.workspace) assertBoundEmail(invite.workspace, input.email);
    const workspaceName = input.workspaceName?.trim();
    if (!invite?.workspace && !workspaceName) {
      throw new RekeyError({
        statusCode: 400,
        code: 'WORKSPACE_NAME_REQUIRED',
        message: 'Sign-up creates a workspace, and no `workspaceName` was given.',
        fix: 'Pass `workspaceName` (1 to 120 characters). It is only optional with an invite key bound to an existing workspace.',
      });
    }
    const existing = await prisma.tenantUser.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (existing) {
      throw new RekeyError({
        statusCode: 409,
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'A Rekey operator with that email already exists.',
        fix: 'Sign in instead, or use a different email. Each operator account is unique by email.',
      });
    }

    const passwordHash = await hashPassword(input.password);
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.tenantUser.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash,
          ...(input.name !== undefined && { name: input.name }),
        },
      });
      const joined = await joinOrCreateWorkspace(tx, {
        userId: user.id,
        email: user.email,
        invite,
        // Checked above: only a bound invite gets here without a name.
        workspaceName: workspaceName ?? '',
      });
      if (invite) await consumeSignupInvite(tx, invite, user.id);
      return { ...joined, user };
    });

    // Audit the invite→operator linkage (the most useful operator-creation
    // audit line under invite mode). Best-effort, post-commit.
    if (invite) {
      void recordSecurityEvent({
        type: 'operator.invite_redeemed',
        actorType: 'operator',
        actorId: result.user.id,
        tenantId: result.tenantId,
        ip: input.device?.ip ?? null,
        userAgent: input.device?.userAgent ?? null,
        metadata: {
          inviteId: invite.inviteId,
          via: 'password',
          ...(invite.workspace && { joinedAs: invite.workspace.role }),
        },
      });
    }

    // The confirmation email, where this deployment can send one. Counted
    // against the address's allowance like any mail nobody asked for by
    // address, and never a reason for the sign-up to fail.
    if (operatorConfirmation.ways().mail && (await mayMailUnattended(OPERATOR_EMAIL_SCOPE, result.user.email))) {
      await mailOperatorConfirmation(result.user, result.tenantId).catch(() => undefined);
    }

    const memberships = await loadMemberships(result.user.id);
    return issueSession(
      result.user,
      result.tenantId,
      result.role,
      memberships,
      input.device,
      sessionBasis(result.user, operatorCredentialSuperseded),
    );
  },

  /**
   * Send the signed-in operator another confirmation email.
   *
   * `verificationToken` is the raw token only where tokens are echoed
   * (development with REKEY_DEV_ECHO_AUTH_TOKENS, and the test runner);
   * otherwise it is null and the link is in the mail.
   *
   * @example
   *   const { emailSent } = await tenantAuthService.resendVerification(req.tenantUser!.id);
   */
  async resendVerification(
    tenantUserId: string,
  ): Promise<{ emailSent: boolean; alreadyVerified: boolean; verificationToken: string | null }> {
    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: tenantUserId } });
    if (user.emailVerified) return { emailSent: false, alreadyVerified: true, verificationToken: null };
    if (!operatorConfirmation.ways().mail) {
      throw new RekeyError({
        statusCode: 409,
        code: 'OPERATOR_CONFIRMATION_EMAIL_UNAVAILABLE',
        message: 'This deployment cannot send email, so no confirmation email was sent.',
        fix: operatorConfirmation.possible()
          ? operatorConfirmationFix({ hasSecondFactor: await tenantMfaService.isEnrolled(user.id) })
          : 'Nothing is refused to an unconfirmed account on this deployment, so there is nothing to confirm yet. To send confirmation emails, set PANEL_URL, RESEND_DEFAULT_API_KEY and RESEND_DEFAULT_FROM on the API and restart it.',
      });
    }
    const reserved = await reserveAuthEmail(OPERATOR_EMAIL_SCOPE, user.email);
    if (!reserved.allowed) throw authEmailCappedError(reserved.retryAfterSeconds);
    const sent = await mailOperatorConfirmation(user, await primaryTenantId(user.id));
    return { ...sent, alreadyVerified: false };
  },

  /**
   * Consume a confirmation link, for the signed-in operator it was mailed
   * for. It sets `emailVerified` and nothing else: the link ratifies the
   * sign-up, password included, where a sign-in link, a provider or a reset
   * on an unconfirmed account replaces what was there. No session is issued.
   *
   * The session is what makes ratifying safe. The link goes to the mailbox,
   * and the mailbox owner may not be who created the account. Whoever can
   * sign in to it already holds its password, so keeping that password takes
   * nothing from them; a mailbox owner who cannot sign in has only the routes
   * that replace it.
   *
   * @example
   *   await tenantAuthService.verifyEmail({ token, tenantUserId: req.tenantUser!.id });
   */
  async verifyEmail(input: {
    token: string;
    tenantUserId: string;
    device?: TenantDeviceContext;
  }): Promise<{ ok: true; emailVerified: true }> {
    const outcome = await lookupTenantEmailVerificationToken(input.token);
    if (outcome.kind === 'unknown') {
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_VERIFICATION_TOKEN_INVALID',
        message: 'Confirmation token is unknown, or a newer confirmation email replaced it.',
        fix: 'Use the link in the newest confirmation email, or request a fresh one via POST /api/v1/tenant/auth/resend-verification.',
      });
    }
    if (outcome.kind === 'consumed') {
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_VERIFICATION_TOKEN_USED',
        message: 'Confirmation token has already been used.',
        fix: 'Nothing to do if the address is already confirmed: GET /api/v1/tenant/auth/me shows `emailVerified`. If it is not, request a fresh confirmation email via POST /api/v1/tenant/auth/resend-verification.',
      });
    }
    if (outcome.kind === 'expired') {
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_VERIFICATION_TOKEN_EXPIRED',
        message: 'Confirmation token has expired.',
        fix: 'Request a fresh confirmation email via POST /api/v1/tenant/auth/resend-verification.',
      });
    }
    const { token } = outcome;
    let holder: { email: string } | null = null;
    if (token.tenantUserId !== input.tenantUserId) {
      throw new RekeyError({
        statusCode: 403,
        code: 'EMAIL_VERIFICATION_WRONG_ACCOUNT',
        message: 'This confirmation link belongs to a different account than the one signed in.',
        fix: 'Sign in as the account the confirmation email was sent to, then open the link again. The link was not used up.',
      });
    }
    const confirmedNow = await prisma.$transaction(async (tx) => {
      const consumed = await tx.tenantEmailVerificationToken.updateMany({
        where: { id: token.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw new RekeyError({
          statusCode: 401,
          code: 'EMAIL_VERIFICATION_TOKEN_USED',
          message: 'Confirmation token has already been used.',
          fix: 'Nothing to do if the address is already confirmed: GET /api/v1/tenant/auth/me shows `emailVerified`. If it is not, request a fresh confirmation email via POST /api/v1/tenant/auth/resend-verification.',
        });
      }
      holder = await tx.tenantUser.findUnique({
        where: { id: token.tenantUserId },
        select: { email: true },
      });
      if (!holder || holder.email !== token.email) {
        throw new RekeyError({
          statusCode: 401,
          code: 'EMAIL_VERIFICATION_STALE',
          message: 'This confirmation link was sent to an address the account no longer uses.',
          fix: 'Request a fresh confirmation email via POST /api/v1/tenant/auth/resend-verification.',
        });
      }
      const flipped = await tx.tenantUser.updateMany({
        where: { id: token.tenantUserId, emailVerified: false },
        data: { emailVerified: true },
      });
      return flipped.count === 1;
    });
    invalidateOperatorAuth(token.tenantUserId);
    if (confirmedNow) {
      // A security notice, so not counted against the per-recipient cap. If
      // the person at the mailbox did not do this, it tells them what to do.
      const tenantId = await primaryTenantId(token.tenantUserId);
      void emailService
        .dispatchSystem({
          eventKey: 'operator_email_confirmed',
          to: token.email,
          variables: {
            userEmail: token.email,
            confirmedAtIso: new Date().toISOString(),
            appUrl: panelBaseUrl() ?? '',
          },
          tenantId,
        })
        .catch(() => undefined);
      void recordSecurityEvent({
        type: 'operator.email_confirmed',
        actorType: 'operator',
        actorId: token.tenantUserId,
        tenantId: await primaryTenantId(token.tenantUserId),
        ip: input.device?.ip ?? null,
        userAgent: input.device?.userAgent ?? null,
        metadata: { via: 'confirmation_link' },
      });
    }
    return { ok: true, emailVerified: true };
  },

  /**
   * Match an operator by verified email, or create one (+ a starter workspace
   * they OWN, mirroring sign-up). For operator OAuth login. The caller
   * (tenant-oauth.service) MUST have confirmed the provider verified the email
   * before calling, we trust `emailVerified` here for the auto-link/create
   * decision, exactly like the end-user OAuth path. OAuth operators have no
   * password (`passwordHash` stays null) until they set one.
   */
  async findOrCreateOAuthOperator(input: {
    email: string;
    name?: string | undefined;
    emailVerified: boolean;
    /** Single-use invite key, required when OPERATOR_SIGNUP_MODE='invite' AND
     *  this login would create a NEW operator. Ignored for existing operators. */
    inviteKey?: string | undefined;
    device?: TenantDeviceContext;
    /**
     * `silent` for the ID Token handoff. An account provisioned for that
     * handoff was registered by automation with a password nobody was shown,
     * so "your password was removed" on its first sign-in reads as an alarm
     * about nothing. The claim itself is unchanged.
     */
    claimNotice?: 'mail' | 'silent';
  }): Promise<{ user: TenantUser; mailboxProven: boolean }> {
    const email = input.email.toLowerCase();
    const existing = await prisma.tenantUser.findUnique({ where: { email } });
    if (existing) {
      // Existing operator, sign-in, never gated.
      if (!input.emailVerified) return { user: existing, mailboxProven: false };
      // The provider vouches for the mailbox. On an account nobody had
      // confirmed, whoever registered the address first must not keep a way in.
      return claimOperatorOnProof(
        existing,
        { via: 'oauth', ip: input.device?.ip ?? null, userAgent: input.device?.userAgent ?? null },
        input.claimNotice,
      );
    }
    // This branch creates a brand-new operator → enforce OPERATOR_SIGNUP_MODE.
    const invite = await resolveSignupInvite(input.inviteKey);
    if (invite?.workspace) assertBoundEmail(invite.workspace, email);
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.tenantUser.create({
        data: {
          email,
          emailVerified: input.emailVerified,
          ...(input.name !== undefined && { name: input.name }),
        },
      });
      const { tenantId } = await joinOrCreateWorkspace(tx, {
        userId: user.id,
        email,
        invite,
        workspaceName: deriveWorkspaceName(input.name, email),
      });
      if (invite) await consumeSignupInvite(tx, invite, user.id);
      return { user, tenantId };
    });
    if (invite) {
      void recordSecurityEvent({
        type: 'operator.invite_redeemed',
        actorType: 'operator',
        actorId: created.user.id,
        tenantId: created.tenantId,
        ip: input.device?.ip ?? null,
        userAgent: input.device?.userAgent ?? null,
        metadata: {
          inviteId: invite.inviteId,
          via: 'oauth',
          ...(invite.workspace && { joinedAs: invite.workspace.role }),
        },
      });
    }
    return { user: created.user, mailboxProven: false };
  },

  /**
   * Finish a passwordless sign-in for a resolved operator, same tail as
   * `signIn` (membership check + MFA gate + session mint). Shared by OAuth
   * (`tenant-oauth`) and magic-link `verifyMagicLink`, so those flows stay out
   * of the session/MFA internals. An MFA-enrolled operator still gets the
   * challenge, the passwordless primary factor doesn't bypass the second one.
   */
  async completeSignIn(
    user: TenantUser,
    device?: TenantDeviceContext,
    proof: { mailboxProven?: boolean } = {},
  ): Promise<TenantSignInOutcome> {
    const memberships = await loadMemberships(user.id);
    if (memberships.length === 0) {
      throw new RekeyError({
        statusCode: 403,
        code: 'NO_TENANT_MEMBERSHIPS',
        message: 'Your account is not a member of any workspace.',
        fix: 'Ask an existing workspace owner for a fresh invitation, or create a new workspace via sign-up.',
      });
    }
    if (await tenantMfaService.isEnrolled(user.id)) {
      const challenge = issueTenantMfaChallengeToken(user.id, {
        mailboxProven: proof.mailboxProven === true && !user.emailVerified,
        basisStamp: user.sessionsInvalidBefore,
      });
      return {
        mfaRequired: true,
        user: redact(user),
        mfaChallengeToken: challenge.token,
        mfaChallengeExpiresAt: challenge.expiresAt,
      };
    }
    const active = memberships[0]!;
    const session = await issueSession(
      user,
      active.tenantId,
      active.role,
      memberships,
      device,
      sessionBasis(user, operatorCredentialSuperseded),
    );
    return { mfaRequired: false, ...session };
  },

  // ---- magic-link (passwordless email sign-in) ----

  /**
   * Request a magic-link token. **Enumeration-safe**: returns one constant
   * body (`CONSTANT_MAGIC_LINK_RESPONSE`) whatever happened, so the response
   * never reveals whether the email maps to an operator.
   *
   * We email the link ourselves via the deployment-wide transport and return
   * `token: null`. The raw token is echoed back only under the dev flag
   * (`REKEY_DEV_ECHO_AUTH_TOKENS`, refused at boot in production) or when no
   * transport is configured, same shape as `requestPasswordReset`.
   */
  async requestMagicLink(input: { email: string }): Promise<{ delivered: boolean; token: string | null }> {
    // Before the lookup, so a known and an unknown address spend the
    // recipient's allowance alike, and a counter outage refuses both.
    const reserved = await reserveAuthEmail(OPERATOR_EMAIL_SCOPE, input.email);
    if (!reserved.allowed) return { ...CONSTANT_MAGIC_LINK_RESPONSE };
    const user = await prisma.tenantUser.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user) {
      // Nothing is sent, so the address keeps its allowance. Not awaited: the
      // answer must not take longer for an address with no account.
      void reserved.unsent();
      // Constant-ish delay to flatten the timing side channel, then the same
      // body a real send produces. `delivered: false` here used to be the
      // whole oracle: one request per address told you which operators exist.
      await new Promise((r) => setTimeout(r, 50));
      return { ...CONSTANT_MAGIC_LINK_RESPONSE };
    }
    const issued = await issueTenantMagicLinkToken(user.id);
    // Deliver via the default transport (RESEND_DEFAULT) + log it. The send is
    // recorded in EmailLog at the transport boundary. Only fall back to
    // returning the raw token when there's no transport (or no panel base),
    // self-hosted dev. On a real send we never leak the token in the response.
    const base = panelBaseUrl();
    if (base) {
      const membership = await prisma.tenantMembership.findFirst({
        where: { tenantUserId: user.id },
        orderBy: { createdAt: 'asc' },
        select: { tenantId: true },
      });
      const outcome = await emailService.dispatchSystem({
        eventKey: 'magic_link_signin',
        to: user.email,
        variables: {
          userEmail: user.email,
          signInUrl: `${base}/login/magic-link?token=${encodeURIComponent(issued.raw)}`,
          expiresAtIso: issued.record.expiresAt.toISOString(),
        },
        tenantId: membership?.tenantId ?? null,
      });
      if (outcome.kind === 'sent') return { ...CONSTANT_MAGIC_LINK_RESPONSE };
      if (outcome.kind === 'error') {
        void recordAuthEmailDeliveryFailure({
          applicationId: null,
          tenantId: membership?.tenantId ?? null,
          eventKey: 'magic_link_signin',
          reason: outcome.message,
        });
      }
    }
    // Same reasoning as requestPasswordReset above, and worse: this token IS a
    // session, verifying it signs the holder in as the operator outright.
    if (!echoAuthTokensInDev()) return { ...CONSTANT_MAGIC_LINK_RESPONSE };
    return { delivered: true, token: issued.raw };
  },

  /**
   * Consume a magic-link token (single-use) and mint a session. The token is a
   * passwordless PRIMARY factor, `completeSignIn` still applies the MFA gate.
   */
  async verifyMagicLink(input: { token: string; device?: TenantDeviceContext }): Promise<TenantSignInOutcome> {
    const outcome = await lookupTenantMagicLinkToken(input.token);
    if (outcome.kind === 'unknown') {
      throw new RekeyError({
        statusCode: 401,
        code: 'MAGIC_LINK_TOKEN_INVALID',
        message: 'Magic-link token is unknown.',
        fix: 'Request a fresh magic link via /tenant/auth/magic-link/request.',
      });
    }
    if (outcome.kind === 'consumed') {
      throw new RekeyError({
        statusCode: 401,
        code: 'MAGIC_LINK_TOKEN_USED',
        message: 'Magic-link token has already been used.',
        fix: 'Request a fresh magic link.',
      });
    }
    if (outcome.kind === 'expired') {
      throw new RekeyError({
        statusCode: 401,
        code: 'MAGIC_LINK_TOKEN_EXPIRED',
        message: 'Magic-link token has expired.',
        fix: 'Request a fresh magic link.',
      });
    }
    // Consume BEFORE minting the session so a lost race can't double-spend.
    const consumed = await consumeTenantMagicLinkToken(outcome.token);
    if (!consumed) {
      throw new RekeyError({
        statusCode: 401,
        code: 'MAGIC_LINK_TOKEN_USED',
        message: 'Magic-link token has already been used.',
        fix: 'Request a fresh magic link.',
      });
    }
    const holder = await prisma.tenantUser.findUniqueOrThrow({ where: { id: outcome.token.tenantUserId } });
    // The link went to the mailbox and nowhere else, so consuming it proves
    // the address. On an account nobody had confirmed that is a claim.
    const { user, mailboxProven } = await claimOperatorOnProof(holder, {
      via: 'magic_link',
      ip: input.device?.ip ?? null,
      userAgent: input.device?.userAgent ?? null,
    });
    return this.completeSignIn(user, input.device, { mailboxProven });
  },

  async signIn(input: {
    email: string;
    password: string;
    device?: TenantDeviceContext;
  }): Promise<TenantSignInOutcome> {
    const user = await prisma.tenantUser.findUnique({
      where: { email: input.email.toLowerCase() },
    });

    // Account lockout via the Redis brute-force limiter, surface 429 during
    // the lock window rather than running argon2 / leaking timing.
    const lockScope = operatorLoginLockScope(input.email);
    await assertNotLocked(lockScope);

    // `verifyPasswordOrDecoy`, not `verifyPassword`: the latter returns
    // instantly for a null hash, so an unknown email answered in ~3 ms against
    // ~9 ms for a real one, a clean, separable account-existence oracle on an
    // unauthenticated endpoint. The decoy costs the same argon2 work.
    const ok = await verifyPasswordOrDecoy(user?.passwordHash ?? null, input.password);
    if (!ok || user === null) {
      // Counted for an unknown email too, and that is the deliberate
      // difference from the end-user path.
      //
      // The end-user limiter records failures only for accounts that exist, so
      // an attacker cannot lock out an address before its owner registers it.
      // That reasoning does not transfer here: operator sign-up is not a public
      // funnel (it is invite-gated on any deployment that has been configured),
      // and skipping the count made the 429-vs-401 divergence after 10 attempts
      // a *louder* existence oracle than the timing one above, no measurement
      // required, just a loop and a status code.
      const failure = await registerFailure(lockScope, LOGIN_POLICY);

      // Durable audit trail. A locked-out operator used to leave no trace in
      // any operator- or admin-facing surface at all: the lockout was a Redis
      // key with a TTL and nothing wrote a row, so "why can't the workspace
      // owner sign in?" had no answer anywhere. Attributed to the operator's
      // primary workspace, see `primaryTenantId` for why null would be
      // invisible. Fire-and-forget, like every other audit write.
      //
      // Emitted only when the account EXISTS. Recording attempts against
      // unknown addresses would let anyone write attacker-chosen strings into
      // a workspace's audit log, and there is no workspace to attribute them
      // to in any case.
      if (user) {
        void (async (): Promise<void> => {
          const tenantId = await primaryTenantId(user.id);
          if (tenantId === null) return;
          await recordSecurityEvent({
            type: 'operator.sign_in_failed',
            actorType: 'operator',
            actorId: user.id,
            tenantId,
            ip: input.device?.ip ?? null,
            userAgent: input.device?.userAgent ?? null,
            metadata: { via: 'password', failuresInWindow: failure.failures },
          });
          if (failure.locked) {
            // Once per lockout, on the attempt that tripped it, not on every
            // attempt refused during the window.
            await recordSecurityEvent({
              type: 'operator.locked_out',
              actorType: 'operator',
              actorId: user.id,
              tenantId,
              ip: input.device?.ip ?? null,
              userAgent: input.device?.userAgent ?? null,
              metadata: {
                via: 'password',
                failuresInWindow: failure.failures,
                lockedForSec: failure.lockedForSec,
              },
            });
          }
        })().catch(() => undefined);
      }

      throw invalidCredentials();
    }

    // Success, clear the failure counter + any lock.
    await clearFailures(lockScope);

    const memberships = await loadMemberships(user.id);
    if (memberships.length === 0) {
      // Edge case, user exists but every membership got revoked. Likely a
      // freshly-revoked account. Block them with a friendly error rather
      // than issuing a token that points nowhere.
      throw new RekeyError({
        statusCode: 403,
        code: 'NO_TENANT_MEMBERSHIPS',
        message: 'Your account is not a member of any workspace.',
        fix: 'Ask an existing workspace owner for a fresh invitation, or create a new workspace via sign-up.',
      });
    }

    // MFA gate, if the operator enrolled, hold the session and emit a
    // 5-min challenge token. The panel exchanges it via /tenant/auth/mfa-verify.
    if (await tenantMfaService.isEnrolled(user.id)) {
      const challenge = issueTenantMfaChallengeToken(user.id, { basisStamp: user.sessionsInvalidBefore });
      return {
        mfaRequired: true,
        user: redact(user),
        mfaChallengeToken: challenge.token,
        mfaChallengeExpiresAt: challenge.expiresAt,
      };
    }

    // Default active workspace = first (oldest) membership. UI can call
    // switchWorkspace to change.
    const active = memberships[0]!;
    const session = await issueSession(user, active.tenantId, active.role, memberships, input.device, {
      sessionsInvalidBefore: user.sessionsInvalidBefore,
      passwordHash: user.passwordHash,
      refusal: invalidCredentials,
    });
    return { mfaRequired: false, ...session };
  },

  /**
   * Exchange an operator MFA challenge token + TOTP/backup code for a
   * real session. Mirrors the end-user `authService.verifyMfaChallenge`.
   */
  async verifyMfaChallenge(input: {
    mfaChallengeToken: string;
    code: string;
    device?: TenantDeviceContext;
  }): Promise<AuthSessionResult> {
    const claims = verifyTenantMfaChallengeToken(input.mfaChallengeToken);
    if (!claims) {
      throw new RekeyError({
        statusCode: 401,
        code: 'MFA_CHALLENGE_INVALID',
        message: 'MFA challenge token is invalid or expired.',
        fix: 'Sign in again to obtain a fresh challenge token (they expire after 5 minutes).',
      });
    }
    if (await isMfaChallengeSpent(input.mfaChallengeToken)) throw mfaChallengeUsedError();
    const codeRefused = (outcome: 'invalid' | 'reused'): RekeyError =>
      outcome === 'reused'
        ? mfaCodeReusedError('sign-in')
        : new RekeyError({
            statusCode: 401,
            code: 'MFA_CODE_INVALID',
            message: 'TOTP or backup code did not verify.',
            fix: 'Enter the current 6-digit code from your authenticator, or a backup code.',
          });
    // Same two phases as the end-user flow: match without spending, refuse
    // on membership only after the second factor is proven and still without
    // spending, then spend the code and claim the challenge.
    const match = await tenantMfaService.match({ tenantUserId: claims.sub, code: input.code });
    if (match.outcome !== 'matched') throw codeRefused(match.outcome);
    let user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: claims.sub } });
    // A challenge from before the account's sessions were all ended stands
    // for a first factor that no longer counts.
    const challengeInvalid = (): RekeyError =>
      new RekeyError({
        statusCode: 401,
        code: 'MFA_CHALLENGE_INVALID',
        message: 'MFA challenge token is invalid or expired.',
        fix: 'Sign in again to obtain a fresh challenge token (they expire after 5 minutes).',
      });
    // The session is issued on the stamp the first factor saw, carried in the
    // challenge, not on whatever the row holds when the code arrives.
    const firstFactorStamp = boundStamp(claims.sib);
    if (
      firstFactorStamp === undefined ||
      unanchoredTokenEnded(claims, user.sessionsInvalidBefore) ||
      (firstFactorStamp?.getTime() ?? null) !== (user.sessionsInvalidBefore?.getTime() ?? null)
    ) {
      throw challengeInvalid();
    }
    const basis: SessionBasis = { sessionsInvalidBefore: firstFactorStamp, refusal: challengeInvalid };
    const memberships = await loadMemberships(user.id);
    if (memberships.length === 0) {
      throw new RekeyError({
        statusCode: 403,
        code: 'NO_TENANT_MEMBERSHIPS',
        message: 'Your account is not a member of any workspace.',
        fix: 'Ask an existing workspace owner for a fresh invitation.',
      });
    }
    const spent = await match.spend();
    if (spent !== 'accepted') throw codeRefused(spent);
    if (!(await claimMfaChallenge(input.mfaChallengeToken, claims.exp))) throw mfaChallengeUsedError();
    if (claims.mbx === true && !user.emailVerified) user = await promoteOperatorAfterMfa(user.id);
    const active = memberships[0]!;
    return issueSession(user, active.tenantId, active.role, memberships, input.device, basis);
  },

  async refresh(presentedRaw: string, device?: TenantDeviceContext): Promise<AuthSessionResult> {
    const outcome = await lookupTenantRefreshToken(presentedRaw);
    if (outcome.kind === 'unknown') {
      throw new RekeyError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Refresh token is unknown.',
        fix: 'Sign in again to obtain a fresh refresh token.',
      });
    }
    if (outcome.kind === 'revoked') {
      // A revoked token has two very different histories, and `replacedById`
      // is what tells them apart:
      //
      //   set  → the token was ROTATED. Someone is replaying a link in the
      //          chain that has already been spent, which is the signature of
      //          a stolen refresh token. Treat compromise of one link as
      //          compromise of the chain and revoke everything.
      //   null → the token was DELIBERATELY revoked, the operator signed this
      //          device out, or revoked it from the sessions list. Replaying
      //          it means only that the device has not noticed yet.
      //
      // Both used to cascade, which made `DELETE /sessions/:id` do the
      // opposite of what it says: the revoked device's next scheduled refresh
      // replayed its token, was read as chain compromise, and signed the
      // operator out of the session they had deliberately KEPT. A revocation
      // the operator performed themselves is not evidence of an attacker.
      //
      // Except a rotated token presented again within moments of its
      // rotation, while its successor is unused: that is the panel racing
      // itself (two tabs, two instances, a retry after a lost response), and
      // it is refused without revoking anything. See `refuseRotatedTenantReplay`.
      if (outcome.token.replacedById !== null) {
        await refuseRotatedTenantReplay(outcome.token, device, 'lookup');
      }
      throw refreshTokenRevoked();
    }
    if (outcome.kind === 'expired') {
      throw new RekeyError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired.',
        fix: 'Sign in again.',
      });
    }
    // Reads before the rotation. The rotation spends the presented token, so
    // anything that can fail after it (a dropped database connection during
    // these reads, answered 503) leaves the client holding a spent token, and
    // the retry it is told to make is a replay. Done first, a failure here
    // costs the client nothing and a 503 is safe to retry.
    const user = await prisma.tenantUser.findUniqueOrThrow({
      where: { id: outcome.token.tenantUserId },
    });
    const memberships = await loadMemberships(user.id);
    if (memberships.length === 0) {
      throw new RekeyError({
        statusCode: 403,
        code: 'NO_TENANT_MEMBERSHIPS',
        message: 'Your account is no longer a member of any workspace.',
        fix: 'Ask a workspace owner for a fresh invitation.',
      });
    }
    // Stay in the workspace the session was in (a switch persists it on the
    // row), as long as the operator is still a member there. Removed since,
    // or a row from before the column existed: the oldest membership, and the
    // replacement row is written there so the next refresh does not search
    // again. Picked before the rotation and handed to it, so nothing is
    // written after the presented token is spent.
    const active =
      memberships.find((m) => m.tenantId === outcome.token.activeTenantId) ?? memberships[0]!;
    let replacement;
    try {
      replacement = await rotateTenantRefreshToken(outcome.token, active.tenantId);
    } catch (e) {
      // Passed the lookup, lost the rotation to a concurrent request: a replay
      // caught mid-flight, judged on the row as the winner committed it.
      if ((e as Error).message === 'TENANT_REFRESH_RACE') {
        const spent = await prisma.tenantRefreshToken.findUniqueOrThrow({ where: { id: outcome.token.id } });
        // Revoked without a successor: the session was ended (a claim, a
        // sign-out, a password change) while this request was in flight. Not
        // a replay, and answering it as one would revoke the sessions of
        // whoever now holds the account.
        if (spent.replacedById === null) throw refreshTokenRevoked();
        await refuseRotatedTenantReplay(spent, device, 'rotation_race');
      }
      throw e;
    }
    const access = issueTenantAccessToken(user.id, active.tenantId, active.role, {
      sessionId: replacement.record.sessionId,
    });
    return {
      user: redact(user),
      memberships,
      activeTenantId: active.tenantId,
      activeRole: active.role,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: replacement.raw,
      refreshTokenExpiresAt: replacement.record.expiresAt,
    };
  },

  async signOut(presentedRaw: string): Promise<void> {
    await revokeTenantRefreshToken(presentedRaw);
  },

  async signOutEverywhere(tenantUserId: string): Promise<{ revokedCount: number }> {
    return { revokedCount: await revokeAllTenantRefreshTokensForUser(tenantUserId) };
  },

  /**
   * Switch the active workspace. Issues a NEW {access, refresh} pair with
   * the new tid and rol; the old tokens stay valid until they expire (the
   * caller should discard them client-side).
   *
   * Could be hardened to revoke the old refresh token here for "exactly
   * one active session per user" semantics, but losing all your other tabs
   * on switch is a worse UX. Operators with stricter requirements call
   * sign-out-everywhere explicitly.
   */
  async switchWorkspace(args: {
    tenantUserId: string;
    targetTenantId: string;
    /** `req.tenantSessionStamp`: the stamp the session middleware admitted this request against. */
    sessionStamp: Date | null;
    device?: TenantDeviceContext;
  }): Promise<AuthSessionResult> {
    const memberships = await loadMemberships(args.tenantUserId);
    const target = memberships.find((m) => m.tenantId === args.targetTenantId);
    if (!target) {
      throw new RekeyError({
        statusCode: 403,
        code: 'NOT_A_MEMBER',
        message: `You are not a member of workspace "${args.targetTenantId}".`,
        fix: 'Ask the workspace owner for an invitation.',
      });
    }
    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: args.tenantUserId } });
    return issueSession(user, target.tenantId, target.role, memberships, args.device, {
      sessionsInvalidBefore: args.sessionStamp,
      refusal: operatorSessionEndedMeanwhile,
    });
  },

  async getById(id: string): Promise<{ user: PublicTenantUser; memberships: MembershipSummary[] }> {
    const user = await prisma.tenantUser.findUnique({ where: { id } });
    if (!user) {
      throw new RekeyError({
        statusCode: 404,
        code: 'TENANT_USER_NOT_FOUND',
        message: 'Operator account not found.',
        fix: 'Sign in again to obtain a valid session.',
      });
    }
    return { user: redact(user), memberships: await loadMemberships(id) };
  },

  // ---- password reset (mirrors end-user shape) ----

  /**
   * Request a password-reset token. **Enumeration-safe**: returns one constant
   * body (`CONSTANT_RESET_RESPONSE`) whatever happened.
   */
  async requestPasswordReset(input: {
    email: string;
  }): Promise<{ delivered: boolean; resetToken: string | null }> {
    // Before the lookup, so a known and an unknown address spend the
    // recipient's allowance alike, and a counter outage refuses both.
    const reserved = await reserveAuthEmail(OPERATOR_EMAIL_SCOPE, input.email);
    if (!reserved.allowed) return { ...CONSTANT_RESET_RESPONSE };
    const user = await prisma.tenantUser.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (!user) {
      // Nothing is sent, so the address keeps its allowance. Not awaited: the
      // answer must not take longer for an address with no account.
      void reserved.unsent();
      // Constant-ish sleep, same shape as end-user requestPasswordReset,
      // then the same body a real send produces. `delivered: false` here used
      // to answer "does this operator exist?" for anyone who asked.
      await new Promise((r) => setTimeout(r, 50));
      return { ...CONSTANT_RESET_RESPONSE };
    }
    const issued = await issueTenantResetToken(user.id);
    // Deliver via the default transport (RESEND_DEFAULT) + log it; fall back to
    // returning the raw token only when there's no transport / panel base.
    const base = panelBaseUrl();
    if (base) {
      const membership = await prisma.tenantMembership.findFirst({
        where: { tenantUserId: user.id },
        orderBy: { createdAt: 'asc' },
        select: { tenantId: true },
      });
      const outcome = await emailService.dispatchSystem({
        eventKey: 'password_reset',
        to: user.email,
        variables: {
          userEmail: user.email,
          resetUrl: `${base}/reset-password?token=${encodeURIComponent(issued.raw)}`,
          expiresAtIso: issued.record.expiresAt.toISOString(),
        },
        tenantId: membership?.tenantId ?? null,
      });
      if (outcome.kind === 'sent') return { ...CONSTANT_RESET_RESPONSE };
      if (outcome.kind === 'error') {
        // Token behaviour is already correct here (the dev flag withholds it in
        // production), but an operator whose mail transport just broke gets no
        // signal at all, they simply cannot recover their own password. Record
        // it so the failure is visible instead of silent. Response shape stays
        // put: this endpoint is unauthenticated, so it must not become an
        // operator-email enumeration oracle.
        void recordAuthEmailDeliveryFailure({
          applicationId: null,
          tenantId: membership?.tenantId ?? null,
          eventKey: 'password_reset',
          reason: outcome.message,
        });
      }
    }
    // These endpoints are UNAUTHENTICATED by necessity (you cannot require a
    // session to recover a forgotten password), so returning the raw token
    // here handed anyone who knew an operator's email a workspace takeover:
    // reset the password, sign in, own the Tenant. Unlike the end-user
    // surface there is no "customer's server forwards it" contract to honour,
    // the panel is first-party.
    //
    // DENY BY DEFAULT: an explicit opt-in flag, not `NODE_ENV !== 'production'`.
    // NODE_ENV defaults to 'development', so a self-hoster running the API
    // outside our Docker image (which does set it) would otherwise have leaked
    // silently. env.ts refuses to boot if this flag is set in production.
    if (!echoAuthTokensInDev()) return { ...CONSTANT_RESET_RESPONSE };
    return { delivered: true, resetToken: issued.raw };
  },

  async resetPassword(input: { token: string; newPassword: string }): Promise<{ ok: true }> {
    await assertOperatorPasswordAcceptable(input.newPassword);
    const outcome = await lookupTenantResetToken(input.token);
    if (outcome.kind === 'unknown') {
      throw new RekeyError({
        statusCode: 401,
        code: 'PASSWORD_RESET_TOKEN_INVALID',
        message: 'Reset token is unknown.',
        fix: 'Request a fresh reset token via /tenant/auth/forgot-password.',
      });
    }
    if (outcome.kind === 'consumed') {
      throw new RekeyError({
        statusCode: 401,
        code: 'PASSWORD_RESET_TOKEN_USED',
        message: 'Reset token has already been used.',
        fix: 'Request a fresh reset token.',
      });
    }
    if (outcome.kind === 'expired') {
      throw new RekeyError({
        statusCode: 401,
        code: 'PASSWORD_RESET_TOKEN_EXPIRED',
        message: 'Reset token has expired.',
        fix: 'Request a fresh reset token.',
      });
    }

    const consumed = await consumeTenantResetToken(outcome.token);
    if (!consumed) {
      throw new RekeyError({
        statusCode: 401,
        code: 'PASSWORD_RESET_TOKEN_USED',
        message: 'Reset token has already been used.',
        fix: 'Request a fresh reset token.',
      });
    }

    const passwordHash = await hashPassword(input.newPassword);
    // The reset link went to the mailbox and nowhere else, so completing it
    // proves the address. On an account nobody had confirmed that is a claim:
    // passkeys, access tokens and grants set by whoever registered first go
    // with the old password.
    // One transaction holding the operator's row (the claim takes it first):
    // the new hash, the stamp and the revocations land together, and a
    // sign-in with the old password that is in flight cannot write a session
    // after them.
    const claim = await prisma.$transaction(async (tx) => {
      const claimed = await claimUnverifiedOperator(
        tx,
        { id: outcome.token.tenantUserId },
        { via: 'password_reset', passwordHash },
      );
      if (claimed.kind === 'claimed') return claimed;
      await tx.tenantUser.update({ where: { id: outcome.token.tenantUserId }, data: { passwordHash } });
      await revokeEveryOperatorSession(tx, outcome.token.tenantUserId);
      return claimed;
    });
    invalidateOperatorAuth(outcome.token.tenantUserId);
    // A reset says nothing by mail about itself. When it claimed the account
    // and removed a passkey, an access token, an MCP grant, a key or an
    // endpoint, or left people and credentials to look over, the address is
    // owed the notice.
    if (claim.kind === 'claimed' && (claim.signInMethodsRemoved || reviewHasFindings(claim.review))) {
      sendOperatorClaimedEmail(claim.user, claim.review);
    }
    return { ok: true };
  },

  async changePassword(input: {
    tenantUserId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: true }> {
    await assertOperatorPasswordAcceptable(input.newPassword);
    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: input.tenantUserId } });
    // The current password is the same secret sign-in checks, so wrong guesses
    // here count toward the same account lockout. Otherwise a stolen session
    // could guess it without limit and never trip the lock sign-in would.
    const lockScope = operatorLoginLockScope(user.email);
    await assertNotLocked(lockScope);
    const ok = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!ok) {
      await registerFailure(lockScope, LOGIN_POLICY);
      throw new RekeyError({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
        fix: 'Verify the current password and try again.',
      });
    }
    await clearFailures(lockScope);
    const newHash = await hashPassword(input.newPassword);
    await prisma.$transaction(async (tx) => {
      const row = await lockOperatorCredentials(tx, user.id);
      // The password that was checked above is no longer the account's.
      if (row?.passwordHash !== user.passwordHash) {
        throw new RekeyError({
          statusCode: 401,
          code: 'INVALID_CREDENTIALS',
          message: 'Current password is incorrect.',
          fix: 'Verify the current password and try again.',
        });
      }
      await tx.tenantUser.update({ where: { id: user.id }, data: { passwordHash: newHash } });
      await revokeEveryOperatorSession(tx, user.id);
    });
    invalidateOperatorAuth(user.id);
    return { ok: true };
  },
};

export type { Tenant };
