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
 *     active workspace (defaults to the OLDEST — `loadMemberships` orders
 *     `createdAt: 'asc'` and callers take `[0]`, so it is the workspace you
 *     joined first, which for most operators is the one they created) and we mint
 *     tokens scoped to that tenant.
 *   - refresh / sign-out / password-reset / change-password mirror the
 *     end-user surface 1:1; the only change is which JWT shape we issue.
 */

import type { Tenant, TenantRole, TenantUser } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { hashPassword, verifyPassword, verifyPasswordOrDecoy } from '../../lib/passwords.js';
import { resolveNewTenantLimits } from '../../lib/tenant-limits.js';
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
  issueTenantRefreshToken,
  lookupTenantRefreshToken,
  rotateTenantRefreshToken,
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

/**
 * Whether to echo raw reset / magic-link tokens back in API responses.
 *
 * Local-development convenience only: it lets the panel render a working
 * reset link with no mail transport configured. Deny-by-default and gated on
 * an explicit flag rather than `NODE_ENV`, because NODE_ENV defaults to
 * 'development' — keying off it would fail OPEN for anyone running the API
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
import { resolveSignupInvite, consumeSignupInvite } from './operator-signup-policy.js';
import { recordSecurityEvent } from '../../lib/security-events.js';

const PASSWORD_MIN_LENGTH = 8;

/**
 * The only rule an operator password had to satisfy, everywhere, was
 * `length >= 8` — so `password` was accepted. Meanwhile the product ships HIBP
 * k-anonymity breach checking for its CUSTOMERS' end-users
 * (`lib/breached-password.ts`, wired into `auth.service.ensurePasswordNotBreached`)
 * and never wired it to its own operators — the accounts that reach every
 * workspace, every end-user and every decrypted billing credential in the
 * deployment. Holding the more privileged account to the weaker standard is
 * backwards.
 *
 * Applies to sign-up, reset and change alike, so there is no path that sets an
 * operator password without passing through this.
 *
 * No availability cost: `checkPasswordBreached` has a 1.5s timeout and fails
 * OPEN — an unreachable HIBP lets the password through rather than blocking
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
 * happened — `delivered: false` for an address with no operator account,
 * `delivered: true` for one that has — which is a complete account-existence
 * oracle on an unauthenticated endpoint, for the accounts that reach every
 * workspace and every decrypted billing credential in the deployment.
 *
 * The end-user surface solved this first and this is the same shape as its
 * `PUBLISHABLE_SEND_RESPONSE`: unknown address, real send, and broken transport
 * are byte-identical to the caller, and the real outcome is recorded in the
 * security log instead. There is no secret-key tier here to exempt — the panel
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

export type PublicTenantUser = Omit<TenantUser, 'passwordHash'>;

function redact(user: TenantUser): PublicTenantUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...rest } = user;
  return rest;
}

/**
 * The workspace a failed sign-in is attributed to.
 *
 * An operator sign-in happens BEFORE a workspace is chosen, so there is no
 * `tenantId` on the request — and every reader of `security_events` is
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
 * Returns null only for an operator with no memberships at all — nothing can
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
 * Operator sign-in MFA challenge — primary factor passed but MFA enrolled.
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
  return rows.map((r) => ({ tenantId: r.tenantId, tenantName: r.tenant.name, role: r.role }));
}

export interface TenantDeviceContext {
  userAgent?: string | null;
  ip?: string | null;
}

async function issueSession(
  user: TenantUser,
  activeTenantId: string,
  activeRole: TenantRole,
  memberships: MembershipSummary[],
  device?: TenantDeviceContext,
): Promise<AuthSessionResult> {
  const access = issueTenantAccessToken(user.id, activeTenantId, activeRole);
  const refresh = await issueTenantRefreshToken(user.id, {
    userAgent: device?.userAgent ?? null,
    ip: device?.ip ?? null,
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

export const tenantAuthService = {
  /**
   * Self-serve sign-up. Atomically creates a TenantUser + a Tenant + an
   * OWNER Membership, then issues a session scoped to the new workspace.
   *
   * If the email already exists, returns EMAIL_ALREADY_EXISTS — sign-in
   * is the right action there.
   */
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

  async signUpAndCreateWorkspace(input: {
    email: string;
    password: string;
    name?: string | undefined;
    workspaceName: string;
    /** Single-use invite key — required when OPERATOR_SIGNUP_MODE='invite'. */
    inviteKey?: string | undefined;
    device?: TenantDeviceContext;
  }): Promise<AuthSessionResult> {
    await assertOperatorPasswordAcceptable(input.password);
    // Enforce OPERATOR_SIGNUP_MODE before doing any work. Validation only —
    // the key is consumed atomically inside the creation transaction below, so
    // a later failure (e.g. duplicate email) does not burn it.
    const invite = await resolveSignupInvite(input.inviteKey);
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
      const tenant = await tx.tenant.create({
        // `resolveNewTenantLimits()` stamps the deployment's
        // DEFAULT_TENANT_LIMITS on the workspace. Unset = no `limits` key at
        // all = unlimited, i.e. what self-serve sign-up has always produced.
        data: {
          name: input.workspaceName,
          ownerEmail: input.email.toLowerCase(),
          ...resolveNewTenantLimits(),
        },
      });
      const user = await tx.tenantUser.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash,
          ...(input.name !== undefined && { name: input.name }),
        },
      });
      await tx.tenantMembership.create({
        data: { tenantUserId: user.id, tenantId: tenant.id, role: 'OWNER' },
      });
      if (invite) await consumeSignupInvite(tx, invite, user.id);
      return { tenant, user };
    });

    // Audit the invite→operator linkage (the most useful operator-creation
    // audit line under invite mode). Best-effort, post-commit.
    if (invite) {
      void recordSecurityEvent({
        type: 'operator.invite_redeemed',
        actorType: 'operator',
        actorId: result.user.id,
        tenantId: result.tenant.id,
        ip: input.device?.ip ?? null,
        userAgent: input.device?.userAgent ?? null,
        metadata: { inviteId: invite.inviteId, via: 'password' },
      });
    }

    const memberships = await loadMemberships(result.user.id);
    return issueSession(result.user, result.tenant.id, 'OWNER', memberships, input.device);
  },

  /**
   * Match an operator by verified email, or create one (+ a starter workspace
   * they OWN, mirroring sign-up). For operator OAuth login. The caller
   * (tenant-oauth.service) MUST have confirmed the provider verified the email
   * before calling — we trust `emailVerified` here for the auto-link/create
   * decision, exactly like the end-user OAuth path. OAuth operators have no
   * password (`passwordHash` stays null) until they set one.
   */
  async findOrCreateOAuthOperator(input: {
    email: string;
    name?: string | undefined;
    emailVerified: boolean;
    /** Single-use invite key — required when OPERATOR_SIGNUP_MODE='invite' AND
     *  this login would create a NEW operator. Ignored for existing operators. */
    inviteKey?: string | undefined;
    device?: TenantDeviceContext;
  }): Promise<TenantUser> {
    const email = input.email.toLowerCase();
    const existing = await prisma.tenantUser.findUnique({ where: { email } });
    if (existing) {
      // Existing operator — sign-in, never gated. The provider vouched for the
      // email, so upgrade a stale unverified flag.
      if (input.emailVerified && !existing.emailVerified) {
        return prisma.tenantUser.update({ where: { id: existing.id }, data: { emailVerified: true } });
      }
      return existing;
    }
    // This branch creates a brand-new operator → enforce OPERATOR_SIGNUP_MODE.
    const invite = await resolveSignupInvite(input.inviteKey);
    const created = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        // Same deployment default as the password path — an operator must not
        // land in a wider workspace by choosing the OAuth button.
        data: {
          name: deriveWorkspaceName(input.name, email),
          ownerEmail: email,
          ...resolveNewTenantLimits(),
        },
      });
      const user = await tx.tenantUser.create({
        data: {
          email,
          emailVerified: input.emailVerified,
          ...(input.name !== undefined && { name: input.name }),
        },
      });
      await tx.tenantMembership.create({
        data: { tenantUserId: user.id, tenantId: tenant.id, role: 'OWNER' },
      });
      if (invite) await consumeSignupInvite(tx, invite, user.id);
      return { user, tenantId: tenant.id };
    });
    if (invite) {
      void recordSecurityEvent({
        type: 'operator.invite_redeemed',
        actorType: 'operator',
        actorId: created.user.id,
        tenantId: created.tenantId,
        ip: input.device?.ip ?? null,
        userAgent: input.device?.userAgent ?? null,
        metadata: { inviteId: invite.inviteId, via: 'oauth' },
      });
    }
    return created.user;
  },

  /**
   * Finish a passwordless sign-in for a resolved operator — same tail as
   * `signIn` (membership check + MFA gate + session mint). Shared by OAuth
   * (`tenant-oauth`) and magic-link `verifyMagicLink`, so those flows stay out
   * of the session/MFA internals. An MFA-enrolled operator still gets the
   * challenge — the passwordless primary factor doesn't bypass the second one.
   */
  async completeSignIn(user: TenantUser, device?: TenantDeviceContext): Promise<TenantSignInOutcome> {
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
      const challenge = issueTenantMfaChallengeToken(user.id);
      return {
        mfaRequired: true,
        user: redact(user),
        mfaChallengeToken: challenge.token,
        mfaChallengeExpiresAt: challenge.expiresAt,
      };
    }
    const active = memberships[0]!;
    const session = await issueSession(user, active.tenantId, active.role, memberships, device);
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
   * transport is configured — same shape as `requestPasswordReset`.
   */
  async requestMagicLink(input: { email: string }): Promise<{ delivered: boolean; token: string | null }> {
    const user = await prisma.tenantUser.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user) {
      // Constant-ish delay to flatten the timing side channel, then the same
      // body a real send produces. `delivered: false` here used to be the
      // whole oracle: one request per address told you which operators exist.
      await new Promise((r) => setTimeout(r, 50));
      return { ...CONSTANT_MAGIC_LINK_RESPONSE };
    }
    const issued = await issueTenantMagicLinkToken(user.id);
    // Deliver via the default transport (RESEND_DEFAULT) + log it. The send is
    // recorded in EmailLog at the transport boundary. Only fall back to
    // returning the raw token when there's no transport (or no panel base) —
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
    // session — verifying it signs the holder in as the operator outright.
    if (!echoAuthTokensInDev()) return { ...CONSTANT_MAGIC_LINK_RESPONSE };
    return { delivered: true, token: issued.raw };
  },

  /**
   * Consume a magic-link token (single-use) and mint a session. The token is a
   * passwordless PRIMARY factor — `completeSignIn` still applies the MFA gate.
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
    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: outcome.token.tenantUserId } });
    return this.completeSignIn(user, input.device);
  },

  async signIn(input: {
    email: string;
    password: string;
    device?: TenantDeviceContext;
  }): Promise<TenantSignInOutcome> {
    const user = await prisma.tenantUser.findUnique({
      where: { email: input.email.toLowerCase() },
    });

    // Account lockout via the Redis brute-force limiter — surface 429 during
    // the lock window rather than running argon2 / leaking timing.
    const lockScope = operatorLoginLockScope(input.email);
    await assertNotLocked(lockScope);

    // `verifyPasswordOrDecoy`, not `verifyPassword`: the latter returns
    // instantly for a null hash, so an unknown email answered in ~3 ms against
    // ~9 ms for a real one — a clean, separable account-existence oracle on an
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
      // a *louder* existence oracle than the timing one above — no measurement
      // required, just a loop and a status code.
      const failure = await registerFailure(lockScope, LOGIN_POLICY);

      // Durable audit trail. A locked-out operator used to leave no trace in
      // any operator- or admin-facing surface at all: the lockout was a Redis
      // key with a TTL and nothing wrote a row, so "why can't the workspace
      // owner sign in?" had no answer anywhere. Attributed to the operator's
      // primary workspace — see `primaryTenantId` for why null would be
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
            // Once per lockout — on the attempt that tripped it, not on every
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

      throw new RekeyError({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
        fix: 'Double-check the credentials. If you signed up via OAuth, password sign-in will not work for you.',
      });
    }

    // Success — clear the failure counter + any lock.
    await clearFailures(lockScope);

    const memberships = await loadMemberships(user.id);
    if (memberships.length === 0) {
      // Edge case — user exists but every membership got revoked. Likely a
      // freshly-revoked account. Block them with a friendly error rather
      // than issuing a token that points nowhere.
      throw new RekeyError({
        statusCode: 403,
        code: 'NO_TENANT_MEMBERSHIPS',
        message: 'Your account is not a member of any workspace.',
        fix: 'Ask an existing workspace owner for a fresh invitation, or create a new workspace via sign-up.',
      });
    }

    // MFA gate — if the operator enrolled, hold the session and emit a
    // 5-min challenge token. The panel exchanges it via /tenant/auth/mfa-verify.
    if (await tenantMfaService.isEnrolled(user.id)) {
      const challenge = issueTenantMfaChallengeToken(user.id);
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
    const session = await issueSession(
      user,
      active.tenantId,
      active.role,
      memberships,
      input.device,
    );
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
    const ok = await tenantMfaService.verify({ tenantUserId: claims.sub, code: input.code });
    if (!ok) {
      throw new RekeyError({
        statusCode: 401,
        code: 'MFA_CODE_INVALID',
        message: 'TOTP or backup code did not verify.',
        fix: 'Enter the current 6-digit code from your authenticator, or a backup code.',
      });
    }
    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: claims.sub } });
    const memberships = await loadMemberships(user.id);
    if (memberships.length === 0) {
      throw new RekeyError({
        statusCode: 403,
        code: 'NO_TENANT_MEMBERSHIPS',
        message: 'Your account is not a member of any workspace.',
        fix: 'Ask an existing workspace owner for a fresh invitation.',
      });
    }
    const active = memberships[0]!;
    return issueSession(user, active.tenantId, active.role, memberships, input.device);
  },

  async refresh(presentedRaw: string): Promise<AuthSessionResult> {
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
      //   null → the token was DELIBERATELY revoked — the operator signed this
      //          device out, or revoked it from the sessions list. Replaying
      //          it means only that the device has not noticed yet.
      //
      // Both used to cascade, which made `DELETE /sessions/:id` do the
      // opposite of what it says: the revoked device's next scheduled refresh
      // replayed its token, was read as chain compromise, and signed the
      // operator out of the session they had deliberately KEPT. A revocation
      // the operator performed themselves is not evidence of an attacker.
      if (outcome.token.replacedById !== null) {
        await revokeAllTenantRefreshTokensForUser(outcome.token.tenantUserId);
        throw new RekeyError({
          statusCode: 401,
          code: 'REFRESH_TOKEN_REUSED',
          message:
            'Refresh token has already been used. All sessions for this operator have been revoked as a precaution.',
          fix: 'A used refresh token cannot be replayed. Sign in again to obtain a fresh session.',
        });
      }
      throw new RekeyError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_REVOKED',
        message: 'This session was revoked.',
        fix: 'Sign in again. Either this session was signed out, or a reuse of one of its tokens elsewhere revoked the whole family.',
      });
    }
    if (outcome.kind === 'expired') {
      throw new RekeyError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired.',
        fix: 'Sign in again.',
      });
    }
    let replacement;
    try {
      replacement = await rotateTenantRefreshToken(outcome.token);
    } catch (e) {
      if ((e as Error).message === 'TENANT_REFRESH_RACE') {
        await revokeAllTenantRefreshTokensForUser(outcome.token.tenantUserId);
        throw new RekeyError({
          statusCode: 401,
          code: 'REFRESH_TOKEN_REUSED',
          message:
            'Refresh token rotation lost a race with another request. All sessions revoked as a precaution.',
          fix: 'Sign in again to obtain a fresh session.',
        });
      }
      throw e;
    }
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
    const active = memberships[0]!;
    const access = issueTenantAccessToken(user.id, active.tenantId, active.role);
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
    return issueSession(user, target.tenantId, target.role, memberships, args.device);
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
    const user = await prisma.tenantUser.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (!user) {
      // Constant-ish sleep — same shape as end-user requestPasswordReset —
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
        // signal at all — they simply cannot recover their own password. Record
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
    // surface there is no "customer's server forwards it" contract to honour —
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
    await prisma.tenantUser.update({
      where: { id: outcome.token.tenantUserId },
      data: { passwordHash },
    });
    await revokeAllTenantRefreshTokensForUser(outcome.token.tenantUserId);
    return { ok: true };
  },

  async changePassword(input: {
    tenantUserId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: true }> {
    await assertOperatorPasswordAcceptable(input.newPassword);
    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: input.tenantUserId } });
    const ok = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!ok) {
      throw new RekeyError({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
        fix: 'Verify the current password and try again.',
      });
    }
    const newHash = await hashPassword(input.newPassword);
    await prisma.tenantUser.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    await revokeAllTenantRefreshTokensForUser(user.id);
    return { ok: true };
  },
};

export type { Tenant };
