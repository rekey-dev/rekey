/**
 * EndUser auth service.
 *
 * Sign-up and sign-in for an Application's end-users. Honours the
 * Application's `authConfig`:
 *   - `methods` array — sign-up/sign-in are refused if `"password"` isn't enabled.
 *   - `passwordMinLength` — enforced on sign-up.
 *   - `sendVerificationEmailOnSignUp` — sign-up posts the verification link
 *     alongside the welcome mail (default on; forced on when the gate below is).
 *   - `requireEmailVerification` — an unconfirmed address gets NO session, from
 *     any door: sign-up, sign-in, MFA verification, org switch, refresh
 *     (default off).
 *
 * Email is unique **per Application**, not globally — `(applicationId, email)`
 * is the unique constraint in the schema. The same email may exist as
 * separate users across separate Applications.
 *
 * Sign-in failures use a *single* `INVALID_CREDENTIALS` code. We never tell
 * the caller whether the email or the password was wrong; that distinction
 * is the gift that keeps on giving for credential-stuffing attacks. The
 * distinct codes that exist alongside it (lockout, erasure, unverified email)
 * are all raised *after* the password verified, so none of them answers a
 * question an attacker could ask without knowing it.
 */

import { Prisma } from '@prisma/client';
import type { Application, EndUser } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { hashPassword, verifyPassword } from '../../lib/passwords.js';
import { checkPasswordBreached } from '../../lib/breached-password.js';
import { env } from '../../config/env.js';
import {
  issueUserAccessTokenForApp,
  issueMfaChallengeToken,
  verifyMfaChallengeToken,
} from '../../lib/jwt.js';
import {
  issueRefreshToken,
  lookupRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForEndUser,
  listActiveSessions,
  revokeSessionForEndUser,
  type SessionSummary,
} from '../../lib/refresh-tokens.js';
import {
  issueResetToken,
  lookupResetToken,
  consumeResetToken,
} from '../../lib/password-reset.js';
import {
  issueVerificationToken,
  lookupVerificationToken,
  consumeVerificationToken,
} from '../../lib/email-verification.js';
import {
  issueMagicLinkToken,
  lookupMagicLinkToken,
  consumeMagicLinkToken,
} from '../../lib/magic-link.js';
import {
  buildRegistrationOptions,
  verifyRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
} from '../../lib/webauthn.js';
import { storeChallenge, consumeChallenge } from '../../lib/webauthn-challenge.js';
import {
  assertNotLocked,
  registerFailure,
  clearFailures,
  euLoginLockScope,
  LOGIN_POLICY,
} from '../../lib/brute-force.js';
import type { WebAuthnCredential } from '@prisma/client';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { assertNoReservedMetadataKey } from '../../lib/oidc-profile.js';
import { assertSignupAllowed, signupAllowed, type AuthKind } from '../../lib/signup-policy.js';
import { assertEndUserQuota } from '../../lib/tenant-limits.js';
import { endUserRolesService } from '../end-user-roles/end-user-roles.service.js';
import { mfaService } from '../mfa/mfa.service.js';
import { emailService } from '../email/email.service.js';
import { resolveAppUrl, buildTokenUrl } from '../../lib/app-url.js';
import { recordAuthEmailDeliveryFailure } from '../../lib/email-transport.js';
import { webhookService } from '../webhooks/webhook.service.js';

export interface SignUpInput {
  application: Application;
  email: string;
  password: string;
  metadata?: Record<string, unknown>;
  /** Optional `appUrl` used in the welcome email's CTA button. */
  appUrl?: string;
  device?: DeviceContext;
  /**
   * How the request authenticated (`secret` | `publishable`). Threaded from
   * `request.authKind` so `secret_only` apps can refuse user creation from a
   * publishable key. Undefined is treated as non-publishable (server-side).
   */
  authKind?: AuthKind;
}

export interface SignInInput {
  application: Application;
  email: string;
  password: string;
  device?: DeviceContext;
}

/**
 * The one body a PUBLISHABLE caller ever gets back from a
 * "send a credential by email" endpoint, whatever actually happened.
 *
 * Unknown address, delivered, transport broken, no transport configured — all
 * four return this. Anything that varies with account existence is an
 * enumeration oracle, and a publishable key ships in browser bundles, so
 * "reachable by an attacker" means "reachable by anyone who opens devtools".
 *
 * The booleans are deliberately not a report on what happened. A browser cannot
 * act on them (it never receives a token), and the operator still gets the real
 * outcome through the security event and the logs.
 */
const PUBLISHABLE_SEND_RESPONSE = {
  delivered: true,
  emailSent: true,
  resetToken: null,
} as const;

/** Same, for the magic-link shape (the token field is named differently). */
const PUBLISHABLE_MAGIC_LINK_RESPONSE = {
  delivered: true,
  emailSent: true,
  magicLinkToken: null,
} as const;

/** Public-safe shape of an EndUser — `passwordHash` stripped. */
export type PublicEndUser = Omit<EndUser, 'passwordHash'>;

function redact(user: EndUser): PublicEndUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...rest } = user;
  return rest;
}

/**
 * Ceiling on stored `metadata`, measured on the POST-merge object.
 *
 * `metadata` is free-form and end-user-writable, which makes it the one place
 * in the schema where a signed-in user chooses how many bytes we store per row
 * forever. 16 KB is far above any legitimate "display name, avatar URL, a few
 * custom fields" payload and far below the size at which a jsonb column starts
 * hurting the queries that select whole EndUser rows on the hot auth path.
 * Measured after the merge, not on the request body, because a stream of small
 * patches is the way you would grow it past the limit otherwise.
 *
 * Applies to EVERY writer, not just `updateSelf`. It first shipped on the
 * self-service PATCH alone, which meant a 200KB blob posted at sign-up was
 * stored (204,811 bytes) and then permanently bricked that user's own PATCH
 * route: the cap is measured post-merge, so every later self-service write
 * failed on bytes the user could no longer remove. A ceiling one writer
 * enforces is a bug in the other writers, not a ceiling.
 */
export const METADATA_MAX_BYTES = 16 * 1024;

export function assertMetadataWithinLimit(metadata: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  if (bytes > METADATA_MAX_BYTES) {
    throw new RekeyError({
      statusCode: 400,
      code: 'METADATA_TOO_LARGE',
      message: `Metadata would be ${bytes} bytes after merging; the limit is ${METADATA_MAX_BYTES}.`,
      fix: 'Store large values (files, documents, long text) in your own storage and keep only a reference here.',
    });
  }
}

/**
 * GDPR erasure gate (roadmap §10). A tombstoned EndUser (`erasedAt` set) has
 * had its credentials hard-deleted and must NEVER be able to authenticate
 * again — the row only survives to anchor retained financial records. Every
 * SESSION-API path that mints a session or resolves an access token runs
 * through here, so an erased user is uniformly rejected with a single, clear
 * code regardless of which auth method is attempted (password, magic-link,
 * OAuth, refresh, or a still-valid access token presented at the session
 * chokepoint).
 *
 * It is not the only implementation of the rule, and this docblock used to
 * claim it was. The per-Application OAuth/OIDC surface has to answer in the
 * `{ error, error_description }` dialect its clients parse, not the Rekey
 * envelope, so it enforces the identical rule through `liveGrantSubject` in
 * modules/mcp/oauth.service.ts — code redemption, the refresh grant,
 * `/userinfo` and the MCP endpoint. Change one, change both.
 *
 * 410 Gone (not 401): the account existed and was deliberately erased — a
 * distinct, non-retryable terminal state. The customer's app should treat it
 * as "this user is gone" and stop re-prompting for credentials.
 */
function assertEndUserNotErased(user: Pick<EndUser, 'erasedAt'>): void {
  if (user.erasedAt !== null) {
    throw new RekeyError({
      statusCode: 410,
      code: 'END_USER_ERASED',
      message: 'This end-user has been erased (GDPR) and can no longer authenticate.',
      fix: 'The account was permanently erased on an operator data-subject request. It cannot be restored or signed into; create a fresh account if needed.',
    });
  }
}

export interface AuthResult {
  endUser: PublicEndUser;
  /** Short-lived access JWT. Pass via X-Rekey-User-Token. */
  accessToken: string;
  /** Absolute expiry timestamp of the access token. */
  accessTokenExpiresAt: Date;
  /** Long-lived refresh token. Use to mint new access tokens via /auth/refresh. */
  refreshToken: string;
  /** Absolute expiry timestamp of the refresh token. */
  refreshTokenExpiresAt: Date;
}

/**
 * Result of a sign-in attempt against a user with MFA enrolled. The user
 * has proven their password but cannot operate until they also exchange a
 * TOTP/backup code via /auth/mfa-verify. The challenge token is short-lived
 * (5 min), bound to the (endUser, application) pair, and refuses to verify
 * as a real access token (see lib/jwt.ts `typ` claim).
 */
export interface MfaChallengeResult {
  /** Discriminator — clients branch on this. */
  mfaRequired: true;
  /** Tells the UI which user is being challenged, but holds no session. */
  endUser: PublicEndUser;
  /** Send this back to /auth/mfa-verify along with the user's TOTP/backup code. */
  mfaChallengeToken: string;
  mfaChallengeExpiresAt: Date;
}

/** Discriminated union returned by sign-in and OAuth callback. */
export type SignInOutcome =
  | ({ mfaRequired: false; mfaEnrollmentRequired?: boolean } & AuthResult)
  | MfaChallengeResult;

export interface DeviceContext {
  userAgent?: string | null;
  ip?: string | null;
}

async function issuePair(
  application: Application,
  endUser: EndUser,
  device?: DeviceContext,
  activeOrganizationId?: string,
): Promise<AuthResult> {
  // Email-verification chokepoint. THE place a session comes into existence in
  // this service — sign-up, sign-in, MFA verification and org switching all end
  // up here — which is why the gate lives here rather than beside each caller.
  // It used to guard `signIn` alone, so `POST /auth/sign-up` handed out a
  // working access token and a 30-day refresh chain with the flag on, to
  // exactly the population the flag exists for: an attacker who registers an
  // address they cannot read never had to open the mailbox.
  ensureEmailVerified(application, endUser);
  // Honours the app's `authConfig.tokenAlg` (HS256 default, RS256 = JWKS).
  const access = await issueUserAccessTokenForApp(
    application,
    endUser.id,
    activeOrganizationId ? { activeOrganizationId } : {},
  );
  const refresh = await issueRefreshToken(application.id, endUser.id, {
    userAgent: device?.userAgent ?? null,
    ip: device?.ip ?? null,
    activeOrganizationId: activeOrganizationId ?? null,
  });
  return {
    endUser: redact(endUser),
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.raw,
    refreshTokenExpiresAt: refresh.record.expiresAt,
  };
}

/**
 * Bridge for sign-in flows: if the user has MFA enrolled, return a
 * challenge token instead of a real session. Otherwise mint the session.
 *
 * Used by password sign-in and OAuth callback — both flows authenticate
 * the user via *some* primary factor (password, OAuth) and then must
 * gate on MFA before issuing tokens.
 */
export async function issueSessionOrMfaChallenge(
  application: Application,
  endUser: EndUser,
  device?: DeviceContext,
): Promise<SignInOutcome> {
  // GDPR erasure chokepoint: every primary-factor success (password,
  // magic-link, OAuth sign-in, OAuth link) funnels through here before a
  // session/challenge is minted, so an erased user is rejected uniformly.
  assertEndUserNotErased(endUser);
  // Same gate `issuePair` runs, repeated here for the branch that returns
  // BEFORE it: an MFA-enrolled user with an unconfirmed address would otherwise
  // be asked for a TOTP code and only then told to go and read their email.
  // The challenge token holds no session, so this is UX rather than a hole —
  // but a login form that asks for a factor it will not accept is its own bug.
  ensureEmailVerified(application, endUser);
  if (await mfaService.isEnrolled(endUser.id)) {
    const challenge = issueMfaChallengeToken(endUser.id, application.id, application.tokenGeneration);
    return {
      mfaRequired: true,
      endUser: redact(endUser),
      mfaChallengeToken: challenge.token,
      mfaChallengeExpiresAt: challenge.expiresAt,
    };
  }
  const result = await issuePair(application, endUser, device);
  // When the app requires MFA but the user hasn't enrolled, still issue the
  // session but flag it so the customer app can force enrollment.
  const policy = AuthConfigSchema.parse(application.authConfig).mfa;
  return {
    mfaRequired: false,
    ...result,
    ...(policy === 'required' && { mfaEnrollmentRequired: true }),
  };
}

function ensurePasswordMethodEnabled(application: Application): void {
  const config = AuthConfigSchema.parse(application.authConfig);
  if (!config.methods.includes('password')) {
    throw new RekeyError({
      statusCode: 400,
      code: 'AUTH_METHOD_DISABLED',
      message: 'Password sign-up/sign-in is not enabled for this application.',
      fix: 'Enable the "password" method in the application\'s authConfig (Panel → Application → Auth methods).',
    });
  }
}


/**
 * Refuse `password` if it appears in the HIBP Pwned Passwords corpus.
 * Honours per-Application opt-out (`authConfig.passwordBreachCheckEnabled`)
 * and the env-level kill switch (`HIBP_BREACH_CHECK_DISABLED`). Errors /
 * timeouts let the password through — see `lib/breached-password.ts` for
 * the rationale.
 */
async function ensurePasswordNotBreached(
  application: Application,
  password: string,
): Promise<void> {
  if (env.HIBP_BREACH_CHECK_DISABLED) return;
  const config = AuthConfigSchema.parse(application.authConfig);
  if (!config.passwordBreachCheckEnabled) return;
  const result = await checkPasswordBreached(password);
  if (result.breached) {
    throw new RekeyError({
      statusCode: 400,
      code: 'PASSWORD_BREACHED',
      message:
        `This password has been seen in ${result.count.toLocaleString()} known breach corpora and cannot be used.`,
      fix: 'Choose a password you haven\'t used anywhere else. A password manager generating a long random string is the easiest path.',
    });
  }
}

function ensureMagicLinkMethodEnabled(application: Application): void {
  const config = AuthConfigSchema.parse(application.authConfig);
  if (!config.methods.includes('magic_link')) {
    throw new RekeyError({
      statusCode: 400,
      code: 'AUTH_METHOD_DISABLED',
      message: 'Magic-link sign-in is not enabled for this application.',
      fix: 'Enable the "magic_link" method in the application\'s authConfig (Panel → Application → Auth methods).',
    });
  }
}

/**
 * Refuse a session to a user who hasn't confirmed their address, when the
 * Application has `authConfig.requireEmailVerification` on.
 *
 * Its own code rather than `INVALID_CREDENTIALS`: the credential was right, and
 * the only way through is a link sitting in the user's inbox — an app that
 * cannot tell them that sends them round the reset-password loop forever. Same
 * shape as the other "credential fine, account not permitted" refusals
 * (lockout, erasure): distinct code, and a `fix` the customer's UI can act on.
 *
 * Only ever reached after a credential verified (it hangs off `issuePair` and
 * the MFA bridge, both of which run downstream of authentication). Checking
 * earlier would answer "does this address have an account here" for anyone who
 * asks, which is the enumeration oracle the single sign-in error code exists to
 * close.
 */
function ensureEmailVerified(application: Application, endUser: EndUser): void {
  const config = AuthConfigSchema.parse(application.authConfig);
  if (!config.requireEmailVerification || endUser.emailVerified) return;
  throw new RekeyError({
    statusCode: 403,
    code: 'EMAIL_NOT_VERIFIED',
    message: 'Confirm your email address before using this account — check your inbox for the verification link.',
    fix: 'The user has to click the link in their verification email; sign-up always sends one while this setting is on. There is no session to re-send from, so if the mail never arrived an operator marks the address verified from Panel → Application → End-users.',
  });
}

/**
 * Mint a verification token and post the `email_verification` mail.
 *
 * Shared by the explicit `/auth/send-verification` endpoint and the automatic
 * sign-up send, so both produce the same token lifetime, the same link and the
 * same delivery-failure bookkeeping. Never throws for a delivery problem: a
 * transport that is missing (`no_transport`) or broken (`error`) comes back as
 * `emailSent: false`, which is what lets sign-up treat this as best-effort.
 */
async function deliverVerificationEmail(args: {
  application: Application;
  endUser: Pick<EndUser, 'id' | 'email'>;
  /** Caller-supplied link template; `{token}` is substituted. */
  verifyUrl?: string;
  /** Caller-supplied base URL — first rung of the `resolveAppUrl` chain. */
  appUrl?: string;
}): Promise<{ emailSent: boolean; verificationToken: string | null }> {
  const issued = await issueVerificationToken({
    applicationId: args.application.id,
    endUserId: args.endUser.id,
    email: args.endUser.email,
  });
  const outcome = await emailService.dispatch({
    application: args.application,
    eventKey: 'email_verification',
    to: args.endUser.email,
    variables: {
      userEmail: args.endUser.email,
      verifyUrl: args.verifyUrl
        ? args.verifyUrl.replace('{token}', encodeURIComponent(issued.raw))
        : buildTokenUrl(resolveAppUrl(args.application, args.appUrl), '/verify', issued.raw),
      expiresAtIso: issued.record.expiresAt.toISOString(),
    },
  });
  if (outcome.kind === 'sent') {
    return { emailSent: true, verificationToken: null };
  }
  if (outcome.kind === 'error') {
    // Lower stakes than reset/magic-link (this token only flips
    // emailVerified) but the same reasoning: a failed send is not a
    // no-transport deployment, and the token should not land in logs.
    void recordAuthEmailDeliveryFailure({
      applicationId: args.application.id,
      tenantId: args.application.tenantId,
      eventKey: 'email_verification',
      endUserId: args.endUser.id,
      reason: outcome.message,
    });
    return { emailSent: false, verificationToken: null };
  }
  return { emailSent: false, verificationToken: issued.raw };
}

export const authService = {
  async signUp(input: SignUpInput): Promise<AuthResult> {
    ensurePasswordMethodEnabled(input.application);

    const config = AuthConfigSchema.parse(input.application.authConfig);
    assertSignupAllowed(config, input.authKind);
    if (input.password.length < config.passwordMinLength) {
      throw new RekeyError({
        statusCode: 400,
        code: 'PASSWORD_TOO_SHORT',
        message: `Password must be at least ${config.passwordMinLength} characters.`,
        fix: `Send a password of length >= ${config.passwordMinLength}.`,
      });
    }
    await ensurePasswordNotBreached(input.application, input.password);
    if (input.metadata !== undefined) {
      // Same ceiling `updateSelf` applies, applied here too — see
      // `METADATA_MAX_BYTES`. Sign-up is reachable with a publishable key, so
      // "the caller is our own backend" was never true of this path.
      assertMetadataWithinLimit(input.metadata);
      // Identity claims are the operator's to assert, never the subject's. A
      // browser-shipped key must not be able to seed `metadata.oidc` at
      // creation time and pick its own `preferred_username` — that is the same
      // hole as the self-service PATCH, through a different door. A SECRET key
      // is the customer's own server, which IS the operator here.
      if (input.authKind === 'publishable') assertNoReservedMetadataKey(input.metadata);
    }
    // Workspace ceiling. Creation-only — see lib/tenant-limits.ts.
    await assertEndUserQuota(input.application.tenantId);

    const passwordHash = await hashPassword(input.password);
    // Look up the Application's default end-user role. New sign-ups always
    // start in the default role — operators can promote later via the
    // tenant PATCH endpoint.
    const defaultRole = await endUserRolesService.getDefault(input.application.id);

    let endUser: EndUser;
    try {
      endUser = await prisma.endUser.create({
        data: {
          applicationId: input.application.id,
          email: input.email.toLowerCase(),
          passwordHash,
          role: defaultRole.name,
          ...(input.metadata !== undefined && {
            metadata: input.metadata as never,
          }),
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RekeyError({
          statusCode: 409,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'An end-user with that email already exists in this application.',
          fix: 'Use sign-in instead, or pick a different email. Email is unique per Application, not globally.',
        });
      }
      throw e;
    }

    // Welcome email — fire-and-forget. A delivery failure must not break
    // sign-up (the account was created successfully and the user has a
    // session; the email is best-effort).
    void emailService
      .dispatch({
        application: input.application,
        eventKey: 'welcome',
        to: endUser.email,
        variables: {
          userEmail: endUser.email,
          // Resolution chain (caller → per-app setting → redirect-URL origin
          // → DEFAULT_APP_URL). Empty when nothing resolves, which makes the
          // template drop the "Get started" button entirely rather than ship
          // a dead one. See lib/app-url.ts.
          appUrl: resolveAppUrl(input.application, input.appUrl) ?? '',
        },
      })
      .catch(() => undefined);

    // Verification email — same fire-and-forget contract as the welcome mail
    // it rides alongside (it does not replace it). On by default: a new
    // account should be able to confirm its address without the customer's
    // server having to call /auth/send-verification itself. An Application
    // with no email transport configured logs a `no_transport` send and moves
    // on; the token stays valid, so a later re-send still works.
    //
    // Forced when `requireEmailVerification` is on, whatever the send switch
    // says. The gate below refuses this sign-up a session, so the link is the
    // only route into the account and there is no session left to re-send it
    // from — the two settings together would otherwise create accounts nobody,
    // including their owner, could ever reach.
    if (config.sendVerificationEmailOnSignUp || config.requireEmailVerification) {
      void deliverVerificationEmail({
        application: input.application,
        endUser,
        ...(input.appUrl !== undefined && { appUrl: input.appUrl }),
      }).catch(() => undefined);
    }

    // Outbound webhook — `user.created`. Same fire-and-forget contract;
    // the dispatcher's delivery worker handles retries on its own.
    void webhookService
      .emit({
        applicationId: input.application.id,
        type: 'user.created',
        data: {
          user: {
            id: endUser.id,
            email: endUser.email,
            emailVerified: endUser.emailVerified,
            role: endUser.role,
            createdAt: endUser.createdAt.toISOString(),
            metadata: endUser.metadata ?? null,
          },
        },
      })
      .catch(() => undefined);

    // Throws 403 EMAIL_NOT_VERIFIED when the Application requires a confirmed
    // address. The account IS created and the verification mail IS on its way —
    // what the caller does not get is a session, which is the whole point of
    // the setting. Deliberately not a 201-with-null-tokens: `AuthResult` is a
    // published type across four SDKs, and making the tokens nullable to
    // describe a state only one Application in a hundred is in would push the
    // branch into every integrator's code.
    return issuePair(input.application, endUser, input.device);
  },

  async signIn(input: SignInInput): Promise<SignInOutcome> {
    ensurePasswordMethodEnabled(input.application);

    const endUser = await prisma.endUser.findUnique({
      where: {
        applicationId_email: {
          applicationId: input.application.id,
          email: input.email.toLowerCase(),
        },
      },
    });

    // Per-(app, email) lockout via the Redis brute-force limiter. We surface
    // 429 TOO_MANY_FAILED_ATTEMPTS (with Retry-After) during the lock window
    // rather than silent INVALID_CREDENTIALS — yes this leaks "this email has
    // been signed-in-against recently," but the alternative is a legit user
    // staring at "wrong password" while their real password works. Matches
    // Clerk's posture. Keyed by email so it works whether or not the user
    // exists; we only record failures for existing users (no enumeration via
    // lockout of never-registered emails).
    // Scope built by the shared helper in lib/brute-force.ts, not locally: the
    // operator panel reads this same lock back and has to derive the key
    // identically or it reports "not locked" for a locked account.
    const lockScope = euLoginLockScope(input.application.id, input.email);
    await assertNotLocked(lockScope);

    // Single error code — never disclose whether email or password was wrong.
    const valid =
      endUser !== null && (await verifyPassword(endUser.passwordHash, input.password));
    if (!valid || endUser === null) {
      if (endUser) {
        await registerFailure(lockScope, LOGIN_POLICY);
      }
      throw new RekeyError({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
        fix: 'Double-check the credentials. If the user signed up via OAuth, password sign-in will not work for them.',
      });
    }

    // Success — clear the failure counter + any lock.
    await clearFailures(lockScope);

    // MFA-aware: returns a challenge token instead of a session when enrolled.
    // Also where the email-verification gate fires, AFTER the clear above and
    // on purpose: the password WAS correct, so an unverified-address refusal is
    // not a failed attempt and must not push the account toward a lockout. A
    // user waiting on their confirmation link would otherwise lock themselves
    // out by retrying.
    return issueSessionOrMfaChallenge(input.application, endUser, input.device);
  },

  /**
   * Exchange an MFA challenge token + TOTP/backup code for a real session.
   *
   * The challenge token proves the user passed the primary factor (password
   * or OAuth) within the last 5 minutes. The TOTP/backup code proves
   * possession of the second factor. Both are required.
   *
   * Application-scope is enforced: the challenge token's `applicationId`
   * must match the calling secret key's Application. The TOTP secret +
   * backup-code hashes live in `MfaCredential` and are checked via
   * `mfaService.verify`.
   */
  async verifyMfaChallenge(input: {
    application: Application;
    mfaChallengeToken: string;
    code: string;
    device?: DeviceContext;
  }): Promise<AuthResult> {
    const claims = verifyMfaChallengeToken(
      input.mfaChallengeToken,
      input.application.id,
      input.application.tokenGeneration,
    );
    if (!claims) {
      throw new RekeyError({
        statusCode: 401,
        code: 'MFA_CHALLENGE_INVALID',
        message: 'MFA challenge token is invalid or expired.',
        fix: 'Sign in again to obtain a fresh challenge token (they expire after 5 minutes).',
      });
    }
    if (claims.applicationId !== input.application.id) {
      throw new RekeyError({
        statusCode: 401,
        code: 'MFA_CHALLENGE_WRONG_APPLICATION',
        message: 'MFA challenge token belongs to a different application.',
        fix: 'Sign in under the Application the calling secret key represents.',
      });
    }
    const ok = await mfaService.verify({ endUserId: claims.sub, code: input.code });
    if (!ok) {
      throw new RekeyError({
        statusCode: 401,
        code: 'MFA_CODE_INVALID',
        message: 'TOTP or backup code did not verify.',
        fix: 'Enter the current 6-digit code from your authenticator app, or one of the backup codes shown at MFA enrollment.',
      });
    }
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: claims.sub } });
    return issuePair(input.application, endUser, input.device);
  },

  /**
   * Exchange a refresh token for a fresh {access, refresh} pair. The
   * presented refresh is revoked atomically with issuing the replacement
   * — concurrent rotation requests don't both succeed.
   *
   * Cross-application guard: the refresh token's `applicationId` must
   * match the calling secret key's Application.
   */
  async refresh(application: Application, presentedRaw: string): Promise<AuthResult> {
    const outcome = await lookupRefreshToken(presentedRaw);
    if (outcome.kind === 'unknown') {
      throw new RekeyError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Refresh token is unknown.',
        fix: 'Sign the user in again to obtain a fresh refresh token.',
      });
    }
    if (outcome.kind === 'revoked') {
      // Reuse-detection: a token that was already revoked was just presented.
      // Strong compromise signal — either an attacker is replaying a stolen
      // token, or a legit client raced with itself. We can't tell. Revoke
      // every active refresh for this end-user so no live session retains
      // value from the compromised chain. Other devices for the same user
      // are forced to sign in again.
      await revokeAllForEndUser(outcome.token.endUserId);
      throw new RekeyError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_REUSED',
        message:
          'Refresh token has already been used. All sessions for this user have been revoked as a precaution.',
        fix: 'A used refresh token cannot be replayed. Sign the user in again to obtain a fresh session.',
      });
    }
    if (outcome.kind === 'expired') {
      throw new RekeyError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired.',
        fix: 'Sign the user in again.',
      });
    }
    if (outcome.token.applicationId !== application.id) {
      throw new RekeyError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_WRONG_APPLICATION',
        message: 'Refresh token belongs to a different application.',
        fix: 'Issue a fresh token under the Application the calling secret key represents.',
      });
    }
    // Reject MCP-surface refresh tokens at the session endpoint — they're only
    // valid at the per-app OAuth /token endpoint. Prevents cross-surface
    // confusion (an mcp_account token shouldn't mint a full session).
    if (outcome.token.kind !== 'session') {
      throw new RekeyError({
        statusCode: 401,
        code: 'REFRESH_TOKEN_INVALID',
        message: 'This refresh token is not valid for session refresh.',
        fix: 'Use the token endpoint it was issued by, or sign in again.',
      });
    }

    let replacement;
    try {
      replacement = await rotateRefreshToken(outcome.token);
    } catch (e) {
      // `rotateRefreshToken` throws `REFRESH_TOKEN_RACE` when a concurrent
      // rotation already flipped the same row. From the caller's point of
      // view that's indistinguishable from a replayed token — surface the
      // same 401 REUSED code and revoke the family for safety. Without
      // this catch the race propagated as an unhandled 500, leaking timing
      // info AND keeping the chain live.
      if ((e as Error).message === 'REFRESH_TOKEN_RACE') {
        await revokeAllForEndUser(outcome.token.endUserId);
        throw new RekeyError({
          statusCode: 401,
          code: 'REFRESH_TOKEN_REUSED',
          message:
            'Refresh token rotation lost a race with another request. All sessions revoked as a precaution.',
          fix: 'Sign the user in again to obtain a fresh session.',
        });
      }
      throw e;
    }
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: outcome.token.endUserId } });
    // GDPR erasure: a refresh token issued before erasure must not mint a fresh
    // access token. (Erasure also revokes all refresh tokens, but a token
    // rotated in a concurrent request could still reach here — belt and braces.)
    assertEndUserNotErased(endUser);
    // Email-verification gate, re-checked rather than trusted from issue time.
    // A refresh chain lasts 30 days: without this, an operator who switches
    // `requireEmailVerification` on is switching it on for future sign-ins
    // only, and every unconfirmed account that already holds a refresh token
    // keeps renewing for a month. Re-checking bounds that to one access-token
    // lifetime.
    ensureEmailVerified(application, endUser);
    // Preserve the session's active org across refresh, but self-heal: if the
    // user left the org since the last token, drop the `oid` (and clear it on
    // the rotated refresh row) so a stale active org can't linger.
    let oid = replacement.record.activeOrganizationId ?? undefined;
    if (oid) {
      const stillMember = await prisma.organizationMembership.findUnique({
        where: { organizationId_endUserId: { organizationId: oid, endUserId: endUser.id } },
        select: { id: true },
      });
      if (!stillMember) {
        oid = undefined;
        await prisma.refreshToken.update({
          where: { id: replacement.record.id },
          data: { activeOrganizationId: null },
        });
      }
    }
    const access = await issueUserAccessTokenForApp(
      application,
      endUser.id,
      oid ? { activeOrganizationId: oid } : {},
    );
    return {
      endUser: redact(endUser),
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: replacement.raw,
      refreshTokenExpiresAt: replacement.record.expiresAt,
    };
  },

  /**
   * Set (or clear) the session's active organization and mint a fresh
   * {access, refresh} pair carrying the `oid` claim. Membership MUST be
   * validated by the caller (the route does `requireMembership`) before
   * calling this with a non-null org. Pass `null` to switch back to the
   * personal pool. Mirrors the operator-side `switchWorkspace`.
   */
  async switchActiveOrganization(args: {
    application: Application;
    endUserId: string;
    activeOrganizationId: string | null;
    device?: DeviceContext;
  }): Promise<AuthResult> {
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: args.endUserId } });
    return issuePair(
      args.application,
      endUser,
      args.device,
      args.activeOrganizationId ?? undefined,
    );
  },

  /**
   * Revoke a refresh token. Idempotent — calling on an already-revoked or
   * unknown token is a no-op (we don't disclose whether it existed).
   */
  async signOut(presentedRaw: string): Promise<void> {
    await revokeRefreshToken(presentedRaw);
  },

  /**
   * Issue a password-reset token.
   *
   * ENUMERATION — a PUBLISHABLE caller always gets the same body, whatever
   * happened: `{ delivered: true, emailSent: true, resetToken: null }`. That is
   * the classic "if an account exists we have emailed it" response, and for a
   * browser it is the only safe one: the key ships in a JS bundle, so anything
   * that varies with account existence is an oracle anyone can read.
   *
   * Those two booleans therefore carry NO information for a publishable caller.
   * They are not a report on what happened, and a browser cannot act on them
   * anyway — it never receives a token in either case.
   *
   * A SECRET-key caller still gets the truth, because it needs it: the
   * no-transport contract hands it the raw token to forward, so it must be able
   * to tell "there is no such user" from "here is the token". A secret key is a
   * server-side credential, so enumeration there is bounded by the customer's
   * own backend rather than exposed to the internet.
   *
   * Delivery strategy:
   *   - If the Application has BYO Resend creds (or RESEND_DEFAULT_API_KEY
   *     is set), we transport the email ourselves and return
   *     `{ delivered: true, emailSent: true, resetToken: null }`. The
   *     customer's server has no further work.
   *   - Otherwise (no transport configured) a SECRET-key caller gets the raw
   *     token in `resetToken` — the legacy "Rekey does not send email"
   *     contract where the customer's server forwards it via their own
   *     provider. A PUBLISHABLE-key caller never does: that key ships in
   *     browser code, so handing it a reset token is account takeover.
   *
   * `resetUrl` is optional; when unset we substitute a placeholder so the
   * customer's app templates remain valid. Callers should always supply
   * it for working links.
   */
  async requestPasswordReset(input: {
    application: Application;
    email: string;
    /** Optional URL the email's reset button should point at, with `{token}` substituted. */
    resetUrl?: string;
    /**
     * Which credential the caller presented. A publishable key is meant to be
     * embedded in browser code, so it must NEVER receive the raw reset token —
     * see the fallback branch below.
     */
    authKind?: AuthKind;
  }): Promise<{
    delivered: boolean;
    emailSent: boolean;
    resetToken: string | null;
  }> {
    ensurePasswordMethodEnabled(input.application);
    const endUser = await prisma.endUser.findUnique({
      where: {
        applicationId_email: {
          applicationId: input.application.id,
          email: input.email.toLowerCase(),
        },
      },
    });
    if (!endUser) {
      // Sleep a tiny constant amount to flatten timing attacks against the
      // existence-of-email side channel. Not bulletproof (requires lots more
      // work to fully neutralise), but raises the bar without much cost.
      await new Promise((r) => setTimeout(r, 50));
      // A browser caller must not be able to tell this branch from a real send.
      if (input.authKind === 'publishable') return PUBLISHABLE_SEND_RESPONSE;
      return { delivered: false, emailSent: false, resetToken: null };
    }
    const issued = await issueResetToken(input.application.id, endUser.id);

    const outcome = await emailService.dispatch({
      application: input.application,
      eventKey: 'password_reset',
      to: endUser.email,
      variables: {
        userEmail: endUser.email,
        // Caller-supplied template wins; otherwise build one on the resolved
        // app URL. Empty string when nothing resolves — the template then
        // renders no button at all instead of linking a live reset token to
        // a domain the operator does not own.
        resetUrl: input.resetUrl
          ? input.resetUrl.replace('{token}', encodeURIComponent(issued.raw))
          : buildTokenUrl(resolveAppUrl(input.application), '/reset', issued.raw),
        expiresAtIso: issued.record.expiresAt.toISOString(),
      },
    });

    if (outcome.kind === 'sent') {
      // Email delivered via our transport — never expose the raw token to
      // the API caller. The user receives it in their inbox.
      return { delivered: true, emailSent: true, resetToken: null };
    }
    // Everything below reports what actually happened, which is exactly what a
    // publishable caller must not learn. Collapse it to the constant response;
    // the security event still records the real outcome for the operator.
    if (outcome.kind === 'error') {
      // Send FAILED (bad key, quota, network) — withhold the token rather than
      // hand a live credential to whatever is logging responses.
      //
      // `emailSent: false` deliberately differs from the delivered path above.
      // It reports TRANSPORT health, not account existence: both branches are
      // reached only by an existing user, so it tells a prober nothing about
      // whether an address has an account. (What does differ on existence is
      // `delivered` — see the caveat on this method's docblock.)
      void recordAuthEmailDeliveryFailure({
        applicationId: input.application.id,
        tenantId: input.application.tenantId,
        eventKey: 'password_reset',
        endUserId: endUser.id,
        reason: outcome.message,
      });
      if (input.authKind === 'publishable') return PUBLISHABLE_SEND_RESPONSE;
      return { delivered: true, emailSent: false, resetToken: null };
    }
    // No transport. The legacy contract hands the raw token back
    // so the customer's SERVER can forward it via its own provider — but that
    // is only ever safe for a secret-key caller. A publishable key lives in
    // browser code, so returning the token there let anyone holding it reset
    // any end-user's password and sign in as them (full account takeover).
    // Browser-driven reset flows require configured email transport; without
    // it we report undelivered and withhold the token.
    if (input.authKind === 'publishable') return PUBLISHABLE_SEND_RESPONSE;
    return { delivered: true, emailSent: false, resetToken: issued.raw };
  },

  /**
   * Consume a reset token + set the new password. On success, every existing
   * refresh token for this user is revoked — anyone holding a session via the
   * compromised credential is signed out.
   */
  async resetPassword(input: {
    application: Application;
    token: string;
    newPassword: string;
  }): Promise<{ ok: true }> {
    const config = AuthConfigSchema.parse(input.application.authConfig);
    if (input.newPassword.length < config.passwordMinLength) {
      throw new RekeyError({
        statusCode: 400,
        code: 'PASSWORD_TOO_SHORT',
        message: `Password must be at least ${config.passwordMinLength} characters.`,
        fix: `Send a password of length >= ${config.passwordMinLength}.`,
      });
    }
    await ensurePasswordNotBreached(input.application, input.newPassword);

    const outcome = await lookupResetToken(input.token);
    if (outcome.kind === 'unknown') {
      throw new RekeyError({
        statusCode: 401,
        code: 'PASSWORD_RESET_TOKEN_INVALID',
        message: 'Reset token is unknown.',
        fix: 'Request a fresh reset token via /api/v1/auth/forgot-password.',
      });
    }
    if (outcome.kind === 'consumed') {
      throw new RekeyError({
        statusCode: 401,
        code: 'PASSWORD_RESET_TOKEN_USED',
        message: 'Reset token has already been used.',
        fix: 'Request a fresh reset token. A used token cannot be replayed.',
      });
    }
    if (outcome.kind === 'expired') {
      throw new RekeyError({
        statusCode: 401,
        code: 'PASSWORD_RESET_TOKEN_EXPIRED',
        message: 'Reset token has expired.',
        fix: 'Request a fresh reset token via /api/v1/auth/forgot-password.',
      });
    }
    if (outcome.token.applicationId !== input.application.id) {
      throw new RekeyError({
        statusCode: 401,
        code: 'PASSWORD_RESET_TOKEN_WRONG_APPLICATION',
        message: 'Reset token belongs to a different application.',
        fix: 'Request a fresh token under the correct Application.',
      });
    }

    const consumed = await consumeResetToken(outcome.token);
    if (!consumed) {
      // Lost the race; another request beat us. Treat as already-used.
      throw new RekeyError({
        statusCode: 401,
        code: 'PASSWORD_RESET_TOKEN_USED',
        message: 'Reset token has already been used.',
        fix: 'Request a fresh reset token.',
      });
    }

    const passwordHash = await hashPassword(input.newPassword);
    // Atomic: revoke every refresh BEFORE flipping the password hash, so a
    // crash mid-flight never leaves us with a new password + the old
    // sessions still live. Both writes commit-or-rollback together.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { endUserId: outcome.token.endUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return tx.endUser.update({
        where: { id: outcome.token.endUserId },
        data: { passwordHash },
      });
    });

    // Notify the user that the password changed — security-critical event.
    // Fire-and-forget; we never let a delivery failure block the reset.
    void emailService
      .dispatch({
        application: input.application,
        eventKey: 'password_changed',
        to: updated.email,
        variables: {
          userEmail: updated.email,
          changedAtIso: new Date().toISOString(),
        },
      })
      .catch(() => undefined);
    void webhookService
      .emit({
        applicationId: input.application.id,
        type: 'password.changed',
        data: { userId: updated.id, email: updated.email, via: 'reset' },
      })
      .catch(() => undefined);

    return { ok: true };
  },

  /**
   * Authenticated password change. Verifies the current password before
   * accepting the new one, then revokes every refresh token for this user
   * so other devices are signed out. The caller's *current* session keeps
   * its access token until it naturally expires (15 min).
   */
  async changePassword(input: {
    application: Application;
    endUserId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: true }> {
    const config = AuthConfigSchema.parse(input.application.authConfig);
    if (input.newPassword.length < config.passwordMinLength) {
      throw new RekeyError({
        statusCode: 400,
        code: 'PASSWORD_TOO_SHORT',
        message: `Password must be at least ${config.passwordMinLength} characters.`,
        fix: `Send a password of length >= ${config.passwordMinLength}.`,
      });
    }
    await ensurePasswordNotBreached(input.application, input.newPassword);

    const endUser = await prisma.endUser.findUnique({ where: { id: input.endUserId } });
    if (!endUser || endUser.applicationId !== input.application.id) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_NOT_FOUND',
        message: 'End-user not found in this application.',
        fix: 'Verify the user id and that the calling secret key belongs to the right Application.',
      });
    }

    const ok = await verifyPassword(endUser.passwordHash, input.currentPassword);
    if (!ok) {
      throw new RekeyError({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
        fix: 'Verify the current password and try again.',
      });
    }

    const newHash = await hashPassword(input.newPassword);
    await prisma.endUser.update({
      where: { id: endUser.id },
      data: { passwordHash: newHash },
    });
    await revokeAllForEndUser(endUser.id);

    void emailService
      .dispatch({
        application: input.application,
        eventKey: 'password_changed',
        to: endUser.email,
        variables: {
          userEmail: endUser.email,
          changedAtIso: new Date().toISOString(),
        },
      })
      .catch(() => undefined);
    void webhookService
      .emit({
        applicationId: input.application.id,
        type: 'password.changed',
        data: { userId: endUser.id, email: endUser.email, via: 'change' },
      })
      .catch(() => undefined);

    return { ok: true };
  },

  /**
   * Revoke every active refresh token for this end-user — "sign out
   * everywhere". The caller's access token stays valid until its 15-min
   * expiry; clear it client-side for a true full logout.
   */
  async signOutEverywhere(endUserId: string): Promise<{ revokedCount: number }> {
    const revokedCount = await revokeAllForEndUser(endUserId);
    return { revokedCount };
  },

  /**
   * Request a magic-link sign-in email.
   *
   * Enumeration-safe: same response shape whether the email exists or not.
   * When transport is configured (BYO Resend or RESEND_DEFAULT_*), we send
   * and hide the token. Otherwise the legacy contract applies — caller
   * receives the raw token in `magicLinkToken` to forward via their own
   * provider.
   *
   * When sign-up is enabled and the email has no account yet, we issue a
   * token with `endUserId = null`. The verify path creates the EndUser
   * atomically with the consume — so the token can't be replayed to mint
   * multiple accounts, AND the welcome / verified-email side-effects fire
   * exactly once.
   */
  async requestMagicLink(input: {
    application: Application;
    email: string;
    /** Optional URL containing the literal `{token}` placeholder. */
    signInUrl?: string;
    /** Calling key kind — gates new-user link issuance under `secret_only`. */
    authKind?: AuthKind;
  }): Promise<{
    delivered: boolean;
    emailSent: boolean;
    magicLinkToken: string | null;
  }> {
    ensureMagicLinkMethodEnabled(input.application);
    const config = AuthConfigSchema.parse(input.application.authConfig);

    const email = input.email.toLowerCase();
    const endUser = await prisma.endUser.findUnique({
      where: { applicationId_email: { applicationId: input.application.id, email } },
    });

    // Refuse to mint a magic link that would auto-create a user when this
    // caller isn't allowed to create one (invite_only, or secret_only reached
    // with a publishable key) — preserves the invite-only / secret-only posture.
    // Existing users still get a sign-in link.
    //
    // Under the default `public` signup mode this branch is unreachable, so a
    // known and an unknown address are genuinely indistinguishable. Under
    // invite_only / secret_only it is reachable, and then `delivered` differs on
    // existence — the same caveat as requestPasswordReset. Silent refusal and
    // padded timing narrow it; they do not close it.
    if (!endUser && !signupAllowed(config, input.authKind)) {
      // Sleep to flatten the timing side channel. A publishable caller gets the
      // constant response so this refusal is indistinguishable from a real send;
      // under the default `public` signup mode the branch is unreachable anyway.
      await new Promise((r) => setTimeout(r, 50));
      if (input.authKind === 'publishable') return PUBLISHABLE_MAGIC_LINK_RESPONSE;
      return { delivered: false, emailSent: false, magicLinkToken: null };
    }

    const issued = await issueMagicLinkToken({
      applicationId: input.application.id,
      endUserId: endUser?.id ?? null,
      email,
    });

    const outcome = await emailService.dispatch({
      application: input.application,
      eventKey: 'magic_link_signin',
      to: email,
      variables: {
        userEmail: email,
        // Same rule as the reset link, and the stakes are higher: this token
        // IS a session. No resolvable base ⇒ no button, never a dead href.
        signInUrl: input.signInUrl
          ? input.signInUrl.replace('{token}', encodeURIComponent(issued.raw))
          : buildTokenUrl(resolveAppUrl(input.application), '/sign-in/magic', issued.raw),
        expiresAtIso: issued.record.expiresAt.toISOString(),
      },
    });

    if (outcome.kind === 'sent') {
      return { delivered: true, emailSent: true, magicLinkToken: null };
    }
    if (outcome.kind === 'error') {
      // As above, and the stakes are higher: this token IS a session.
      void recordAuthEmailDeliveryFailure({
        applicationId: input.application.id,
        tenantId: input.application.tenantId,
        eventKey: 'magic_link_signin',
        endUserId: endUser?.id ?? null,
        reason: outcome.message,
      });
      if (input.authKind === 'publishable') return PUBLISHABLE_MAGIC_LINK_RESPONSE;
      return { delivered: true, emailSent: false, magicLinkToken: null };
    }
    // Same rule as requestPasswordReset, and the stakes are higher: a
    // magic-link token IS a session — verifying it signs the holder in with no
    // password involved. The raw-token fallback is for a customer's SERVER to
    // forward via its own provider, so it is only ever safe for a secret key.
    // A publishable key lives in browser code; handing it this token is
    // instant account takeover.
    if (input.authKind === 'publishable') return PUBLISHABLE_MAGIC_LINK_RESPONSE;
    return { delivered: true, emailSent: false, magicLinkToken: issued.raw };
  },

  /**
   * Consume a magic-link token and complete sign-in.
   *
   * Returns the same `SignInOutcome` discriminated union as password sign-in
   * — so MFA-enrolled users get a challenge token, others get a session.
   *
   * For tokens issued without an `endUserId` (new-user magic link), the
   * EndUser is created atomically inside the consume transaction, with
   * `emailVerified: true` (the magic link is itself proof of email
   * ownership), assigned the Application's default role, and the
   * lifecycle side-effects (welcome email, user.created webhook) fire.
   *
   * An EXISTING user's `emailVerified` is promoted to true on the same
   * reasoning — the proof is identical whether or not the account predates the
   * link. It is only ever set, never cleared.
   *
   * Stale-email guard: if the user's email changed between issue and
   * consume, the token is refused (`MAGIC_LINK_STALE`). It is what makes the
   * promotion above sound: the proof is of the address on the account NOW.
   */
  async verifyMagicLink(input: {
    application: Application;
    token: string;
    device?: DeviceContext;
    /** Calling key kind — a `secret_only` app refuses creation via pub key. */
    authKind?: AuthKind;
  }): Promise<SignInOutcome> {
    ensureMagicLinkMethodEnabled(input.application);

    const outcome = await lookupMagicLinkToken(input.token);
    if (outcome.kind === 'unknown') {
      throw new RekeyError({
        statusCode: 401,
        code: 'MAGIC_LINK_INVALID',
        message: 'Magic-link token is unknown.',
        fix: 'Request a fresh magic link via /api/v1/auth/magic-link/request.',
      });
    }
    if (outcome.kind === 'consumed') {
      throw new RekeyError({
        statusCode: 401,
        code: 'MAGIC_LINK_USED',
        message: 'Magic-link token has already been used.',
        fix: 'Request a fresh magic link.',
      });
    }
    if (outcome.kind === 'expired') {
      throw new RekeyError({
        statusCode: 401,
        code: 'MAGIC_LINK_EXPIRED',
        message: 'Magic-link token has expired.',
        fix: 'Magic links last 15 minutes — request a fresh one.',
      });
    }
    if (outcome.token.applicationId !== input.application.id) {
      throw new RekeyError({
        statusCode: 401,
        code: 'MAGIC_LINK_WRONG_APPLICATION',
        message: 'Magic-link token belongs to a different application.',
        fix: 'Request a fresh token under the correct Application.',
      });
    }

    // Atomic: consume the token + (when needed) create the user. If
    // anything fails, the token stays unconsumed and the user isn't
    // created — operator retry is safe.
    const endUser = await prisma.$transaction(async (tx) => {
      const consumed = await tx.magicLinkToken.updateMany({
        where: { id: outcome.token.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) {
        // Lost a race with another request; treat as already-used.
        throw new RekeyError({
          statusCode: 401,
          code: 'MAGIC_LINK_USED',
          message: 'Magic-link token has already been used.',
          fix: 'Request a fresh magic link.',
        });
      }

      // Existing user: stale-email check, then return.
      if (outcome.token.endUserId) {
        const existing = await tx.endUser.findUniqueOrThrow({
          where: { id: outcome.token.endUserId },
        });
        if (existing.email !== outcome.token.email) {
          throw new RekeyError({
            statusCode: 401,
            code: 'MAGIC_LINK_STALE',
            message:
              'Magic-link token was issued for a different email than is currently on the account.',
            fix: 'Request a fresh magic link.',
          });
        }
        // The user just retrieved a single-use secret we posted to that
        // mailbox and nowhere else. That is the same proof the verification
        // link collects, and the stale-email check above is what makes it
        // proof of the address *currently* on the account. Recording it here
        // is what makes the documented claim — "magic-link and OAuth sign-in
        // each carry their own proof of the address" — actually true: the
        // create branch below always set the flag, so only the account that
        // already existed threw the evidence away, and it kept shipping
        // `email_verified: false` to relying parties forever afterwards.
        if (existing.emailVerified) return existing;
        return tx.endUser.update({
          where: { id: existing.id },
          data: { emailVerified: true },
        });
      }

      // New user: create with verified email + default role. Re-check the
      // signup policy at the moment of creation — a token minted earlier must
      // not let a publishable key create a user in a `secret_only` app.
      assertSignupAllowed(
        AuthConfigSchema.parse(input.application.authConfig),
        input.authKind,
      );
      // Workspace ceiling, checked inside the same transaction as the create.
      // Throwing here rolls the token consume back too, so a link rejected for
      // quota stays usable and works once the workspace has room again.
      await assertEndUserQuota(input.application.tenantId, tx);
      const defaultRole = await endUserRolesService.getDefault(input.application.id);
      try {
        return await tx.endUser.create({
          data: {
            applicationId: input.application.id,
            email: outcome.token.email,
            emailVerified: true,
            role: defaultRole.name,
          },
        });
      } catch (e) {
        // Race: another magic-link consume for the same email won the
        // create. Fetch and return — both consumes converge on the same
        // user, which is the right semantic.
        if ((e as { code?: string }).code === 'P2002') {
          return tx.endUser.findUniqueOrThrow({
            where: {
              applicationId_email: {
                applicationId: input.application.id,
                email: outcome.token.email,
              },
            },
          });
        }
        throw e;
      }
    });

    // Lifecycle side-effects only when the user was newly created. We
    // detect that by re-reading the token (consumed; if it carried no
    // endUserId at issue, this consume just created one).
    if (outcome.token.endUserId === null) {
      void emailService
        .dispatch({
          application: input.application,
          eventKey: 'welcome',
          to: endUser.email,
          variables: {
            userEmail: endUser.email,
            // Magic-link sign-up has no caller-supplied appUrl to pass, so
            // this leans entirely on the per-app / inferred / env chain.
            appUrl: resolveAppUrl(input.application) ?? '',
          },
        })
        .catch(() => undefined);
      void webhookService
        .emit({
          applicationId: input.application.id,
          type: 'user.created',
          data: {
            user: {
              id: endUser.id,
              email: endUser.email,
              emailVerified: endUser.emailVerified,
              role: endUser.role,
              createdAt: endUser.createdAt.toISOString(),
              metadata: endUser.metadata ?? null,
            },
            via: 'magic_link',
          },
        })
        .catch(() => undefined);
    }

    return issueSessionOrMfaChallenge(input.application, endUser, input.device);
  },

  /**
   * Send (or re-send) an email-verification link for the current user.
   * Idempotent — repeated calls mint new tokens (a previous token stays
   * valid until expiry/consume, but real-world this is fine because each
   * one is single-use and the user will click the most recent one).
   *
   * Returns a delivery shape mirroring `requestPasswordReset`: when
   * transport is configured we send and hide the token; otherwise we
   * return the raw value for the caller to forward.
   */
  async sendVerificationEmail(input: {
    application: Application;
    endUserId: string;
    /** Optional URL with `{token}` substituted. */
    verifyUrl?: string;
  }): Promise<{
    emailSent: boolean;
    verificationToken: string | null;
  }> {
    const endUser = await prisma.endUser.findUnique({ where: { id: input.endUserId } });
    if (!endUser || endUser.applicationId !== input.application.id) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_NOT_FOUND',
        message: `EndUser "${input.endUserId}" not found in this application.`,
        fix: 'Verify the user id and that the calling secret key belongs to the right Application.',
      });
    }
    if (endUser.emailVerified) {
      throw new RekeyError({
        statusCode: 400,
        code: 'EMAIL_ALREADY_VERIFIED',
        message: 'This email is already verified.',
        fix: 'No further action is required.',
      });
    }
    return deliverVerificationEmail({
      application: input.application,
      endUser,
      ...(input.verifyUrl !== undefined && { verifyUrl: input.verifyUrl }),
    });
  },

  /**
   * Consume an email-verification token and flip `emailVerified: true`.
   * Single-use; cross-application guard mirrors password reset.
   *
   * Re-using a consumed token returns `EMAIL_VERIFICATION_TOKEN_USED`.
   * The `email` claim on the token is checked against the current
   * EndUser.email so a stale token (issued before an email change) is
   * refused with `EMAIL_VERIFICATION_STALE`.
   */
  async verifyEmail(input: {
    application: Application;
    token: string;
  }): Promise<{ ok: true; endUser: PublicEndUser }> {
    const outcome = await lookupVerificationToken(input.token);
    if (outcome.kind === 'unknown') {
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_VERIFICATION_TOKEN_INVALID',
        message: 'Verification token is unknown.',
        fix: 'Request a fresh verification email via /api/v1/auth/send-verification.',
      });
    }
    if (outcome.kind === 'consumed') {
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_VERIFICATION_TOKEN_USED',
        message: 'Verification token has already been used.',
        fix: 'No further action needed — the email is already verified.',
      });
    }
    if (outcome.kind === 'expired') {
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_VERIFICATION_TOKEN_EXPIRED',
        message: 'Verification token has expired.',
        fix: 'Request a fresh verification email.',
      });
    }
    if (outcome.token.applicationId !== input.application.id) {
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_VERIFICATION_TOKEN_WRONG_APPLICATION',
        message: 'Verification token belongs to a different application.',
        fix: 'Request a fresh token under the correct Application.',
      });
    }
    const endUser = await prisma.endUser.findUniqueOrThrow({
      where: { id: outcome.token.endUserId },
    });
    if (endUser.email !== outcome.token.email) {
      // Email changed since token was issued — verification belongs to a
      // stale address. Refuse rather than retroactively trust the old one.
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_VERIFICATION_STALE',
        message:
          'Verification token was issued for a different email than is currently on the account.',
        fix: 'Request a fresh verification email for the current address.',
      });
    }
    const consumed = await consumeVerificationToken(outcome.token);
    if (!consumed) {
      // Lost the race; treat as already-used.
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_VERIFICATION_TOKEN_USED',
        message: 'Verification token has already been used.',
        fix: 'No further action needed.',
      });
    }
    const updated = await prisma.endUser.update({
      where: { id: endUser.id },
      data: { emailVerified: true },
    });
    void webhookService
      .emit({
        applicationId: input.application.id,
        type: 'email.verified',
        data: { userId: updated.id, email: updated.email },
      })
      .catch(() => undefined);
    return { ok: true, endUser: redact(updated) };
  },

  /**
   * List active sessions (= live refresh tokens) for the current user.
   * Used by /me/sessions to render the "signed in on these devices" panel.
   */
  async listSessions(endUserId: string): Promise<SessionSummary[]> {
    return listActiveSessions(endUserId);
  },

  /**
   * Revoke one session by its DB row id. Scoped to the user so cross-user
   * revocation by id is impossible.
   */
  async revokeSession(args: {
    application: Application;
    endUserId: string;
    sessionId: string;
  }): Promise<{ revoked: boolean }> {
    const revoked = await revokeSessionForEndUser(args.endUserId, args.sessionId);
    if (revoked) {
      void webhookService
        .emit({
          applicationId: args.application.id,
          type: 'session.revoked',
          data: { userId: args.endUserId, sessionId: args.sessionId, via: 'self' },
        })
        .catch(() => undefined);
    }
    return { revoked };
  },

  // ---------- Passkeys / WebAuthn ----------

  /**
   * Begin a passkey registration ceremony for the current user.
   *
   * The customer's server receives `{ options, expectedChallenge }`,
   * forwards `options` to the browser (which hands it to
   * `navigator.credentials.create(...)`), then sends the browser's
   * response back to `passkeyRegisterComplete` along with the same
   * `expectedChallenge`. The challenge is persisted server-side
   * (`lib/webauthn-challenge.ts`) and atomically consumed on complete
   * (single-use, 5-minute TTL), so the posted value is validated against
   * the store rather than trusted — a replayed ceremony fails.
   */
  async passkeyRegisterStart(input: {
    application: Application;
    endUserId: string;
  }): Promise<{
    options: unknown;
    expectedChallenge: string;
  }> {
    const endUser = await prisma.endUser.findUniqueOrThrow({
      where: { id: input.endUserId },
    });
    if (endUser.applicationId !== input.application.id) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_NOT_FOUND',
        message: 'End-user not found in this application.',
        fix: 'Verify the user id and the calling secret key.',
      });
    }
    const existing = await prisma.webAuthnCredential.findMany({
      where: { endUserId: endUser.id },
    });
    const { options, expectedChallenge } = await buildRegistrationOptions({
      application: input.application,
      endUserId: endUser.id,
      userEmail: endUser.email,
      excludeCredentials: existing,
    });
    await storeChallenge({
      challenge: expectedChallenge,
      ceremony: 'registration',
      scope: 'end_user',
      applicationId: input.application.id,
      subjectId: endUser.id,
    });
    return { options, expectedChallenge };
  },

  async passkeyRegisterComplete(input: {
    application: Application;
    endUserId: string;
    expectedChallenge: string;
    response: Parameters<typeof verifyRegistration>[0]['response'];
    deviceName?: string;
  }): Promise<{ credentialId: string; deviceName: string | null }> {
    // Burn the challenge first (single-use, bound to this app + user).
    await consumeChallenge({
      challenge: input.expectedChallenge,
      ceremony: 'registration',
      scope: 'end_user',
      applicationId: input.application.id,
      expectedSubjectId: input.endUserId,
    });
    const verified = await verifyRegistration({
      application: input.application,
      response: input.response,
      expectedChallenge: input.expectedChallenge,
    });
    if (!verified.verified || !verified.registrationInfo) {
      throw new RekeyError({
        statusCode: 401,
        code: 'WEBAUTHN_REGISTRATION_FAILED',
        message: 'Passkey registration did not verify.',
        fix: 'Retry the ceremony. Most failures are due to a stale challenge — start a fresh /register/start before /register/complete.',
      });
    }
    const info = verified.registrationInfo.credential;
    try {
      const created = await prisma.webAuthnCredential.create({
        data: {
          applicationId: input.application.id,
          endUserId: input.endUserId,
          credentialId: info.id,
          publicKey: Buffer.from(info.publicKey).toString('base64url'),
          counter: BigInt(info.counter),
          transports: info.transports ?? [],
          deviceName: input.deviceName ?? null,
        },
      });
      void webhookService
        .emit({
          applicationId: input.application.id,
          type: 'mfa.enabled', // Passkeys are a strong factor; reuse the existing event channel.
          data: { userId: input.endUserId, via: 'passkey', credentialId: created.credentialId },
        })
        .catch(() => undefined);
      return { credentialId: created.credentialId, deviceName: created.deviceName };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        // Credential id already registered — should be caught by the
        // excludeCredentials list at /start, so this means a race.
        throw new RekeyError({
          statusCode: 409,
          code: 'WEBAUTHN_ALREADY_REGISTERED',
          message: 'This passkey is already registered.',
          fix: 'Use the existing credential — registering the same authenticator twice is a no-op.',
        });
      }
      throw e;
    }
  },

  /**
   * Begin a passkey authentication ceremony.
   *
   * Two modes:
   *   - **Usernameless** (`email` omitted): returns options with no
   *     `allowCredentials`. The browser asks the platform / roaming
   *     authenticator to surface any matching resident-key passkey. The
   *     complete path then resolves the user from the credential id the
   *     browser returns (`webauthn_credentials.credential_id` is globally
   *     unique) — there is no `userHandle` column.
   *   - **Email-first** (`email` provided): we scope `allowCredentials`
   *     to that user's registered passkeys.
   *
   * KNOWN GAP: a known email with zero passkeys is currently distinguishable
   * from an unknown email. The intent is for both to return the usernameless
   * shape, but `allowCredentials: []` is emitted for the former (the omission in
   * `lib/webauthn.ts` is keyed on `null`, not on emptiness) while the latter
   * emits no field at all. Fix is to pass `null` when the list is empty.
   */
  async passkeyAuthenticateStart(input: {
    application: Application;
    email?: string;
  }): Promise<{
    options: unknown;
    expectedChallenge: string;
  }> {
    let allowCredentials: WebAuthnCredential[] | null = null;
    if (input.email) {
      const endUser = await prisma.endUser.findUnique({
        where: {
          applicationId_email: {
            applicationId: input.application.id,
            email: input.email.toLowerCase(),
          },
        },
        include: { webauthnCredentials: true },
      });
      if (endUser) {
        allowCredentials = endUser.webauthnCredentials;
      } else {
        // Enumeration guard: fall through to usernameless options so the
        // shape is identical to the no-user case. The complete path then
        // refuses with a non-disclosing error.
        allowCredentials = null;
      }
    }
    const result = await buildAuthenticationOptions({
      application: input.application,
      allowCredentials,
    });
    await storeChallenge({
      challenge: result.expectedChallenge,
      ceremony: 'authentication',
      scope: 'end_user',
      applicationId: input.application.id,
    });
    return result;
  },

  async passkeyAuthenticateComplete(input: {
    application: Application;
    expectedChallenge: string;
    response: Parameters<typeof verifyAuthentication>[0]['response'];
    device?: DeviceContext;
  }): Promise<SignInOutcome> {
    // The credential id the browser returned tells us which row to load.
    const credentialId = (input.response as { id?: string }).id;
    if (typeof credentialId !== 'string') {
      throw new RekeyError({
        statusCode: 400,
        code: 'WEBAUTHN_AUTH_INVALID',
        message: 'Authentication response is missing a credential id.',
        fix: 'Pass the full WebAuthn `AuthenticationResponseJSON` from `navigator.credentials.get(...)`.',
      });
    }
    // Burn the challenge first (single-use, bound to this app) so a captured
    // assertion can't be replayed into a session — the counter check is a
    // no-op for synced platform passkeys (counter = 0), so this is the
    // load-bearing anti-replay control.
    await consumeChallenge({
      challenge: input.expectedChallenge,
      ceremony: 'authentication',
      scope: 'end_user',
      applicationId: input.application.id,
    });
    const credential = await prisma.webAuthnCredential.findUnique({
      where: { credentialId },
    });
    if (!credential || credential.applicationId !== input.application.id) {
      throw new RekeyError({
        statusCode: 401,
        code: 'WEBAUTHN_AUTH_INVALID',
        message: 'Passkey authentication failed.',
        fix: 'Use the passkey registered for this Application, or register a new one.',
      });
    }

    const verified = await verifyAuthentication({
      application: input.application,
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      credential,
    });
    if (!verified.verified) {
      throw new RekeyError({
        statusCode: 401,
        code: 'WEBAUTHN_AUTH_INVALID',
        message: 'Passkey authentication failed.',
        fix: 'Retry — most failures are a stale challenge. Start a fresh /authenticate/start before /authenticate/complete.',
      });
    }
    const newCounter = verified.authenticationInfo.newCounter;
    // Advance the counter monotonically — cloned-authenticator detection.
    // If the new counter is less-than-or-equal, SimpleWebAuthn would have
    // already thrown above, but we still persist defensively.
    await prisma.webAuthnCredential.update({
      where: { id: credential.id },
      data: { counter: BigInt(newCounter), lastUsedAt: new Date() },
    });

    const endUser = await prisma.endUser.findUniqueOrThrow({
      where: { id: credential.endUserId },
    });
    // Passkeys are themselves a strong factor — they bypass MFA challenge
    // (typical Clerk/Auth0 behavior). Customers who want passkey + TOTP
    // belt-and-braces can opt in by not bypassing here in their own flow;
    // we make the simpler trade.
    const result = await issuePair(input.application, endUser, input.device);
    return { mfaRequired: false, ...result };
  },

  async listPasskeys(endUserId: string): Promise<
    Array<{
      id: string;
      credentialId: string;
      deviceName: string | null;
      lastUsedAt: Date | null;
      createdAt: Date;
    }>
  > {
    return prisma.webAuthnCredential.findMany({
      where: { endUserId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        credentialId: true,
        deviceName: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });
  },

  async deletePasskey(args: {
    application: Application;
    endUserId: string;
    credentialRowId: string;
  }): Promise<{ deleted: boolean }> {
    // Scoped delete: the WHERE matches both id + endUserId so a stolen
    // credentialRowId can't be used to drop another user's passkey.
    const result = await prisma.webAuthnCredential.deleteMany({
      where: {
        id: args.credentialRowId,
        endUserId: args.endUserId,
        applicationId: args.application.id,
      },
    });
    return { deleted: result.count === 1 };
  },

  async getById(applicationId: string, endUserId: string): Promise<PublicEndUser> {
    const endUser = await prisma.endUser.findUnique({ where: { id: endUserId } });
    if (!endUser || endUser.applicationId !== applicationId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_NOT_FOUND',
        message: `EndUser "${endUserId}" not found in this application.`,
        fix: 'Verify the user id and that the calling secret key belongs to the right Application.',
      });
    }
    // GDPR erasure chokepoint: `requireUserSession` resolves the current user
    // through here on EVERY end-user-scoped route, so a still-unexpired access
    // token minted before erasure is rejected the moment it's used.
    assertEndUserNotErased(endUser);
    return redact(endUser);
  },

  /**
   * Self-service update of the caller's OWN EndUser record.
   *
   * The field list is a **closed allowlist**, and it is closed rather than
   * open (i.e. "everything except a deny-list") on purpose: an open list
   * silently grants whatever column the next schema migration adds. `role` is
   * the concrete danger — it is the per-app RBAC field, so an open shape would
   * let any signed-in user promote themselves the moment the request body
   * happened to name it. `email` is an identity change that must go through
   * verification, `passwordHash` has its own step-up-guarded route, and
   * `erasedAt`/`erasedBy` are the GDPR tombstone, which only an operator sets.
   * None of those are things a user may hand themselves; adding a field here
   * has to be a deliberate act.
   *
   * **Merge semantics for `metadata`: top-level shallow merge.**
   *   - key omitted from the patch → left exactly as it was
   *   - key present with a value  → replaces that top-level key **wholesale**
   *     (nested objects are NOT deep-merged — `{a:{b:1}}` over `{a:{c:2}}`
   *     leaves `{a:{b:1}}`)
   *   - key present with `null`   → deleted from the stored object
   *   - `metadata: null`          → clears the whole column to SQL NULL
   *
   * Merge, not replace, because the verb is PATCH and because replace is the
   * semantics that quietly destroys data: a client that reads, edits one key
   * and writes back would drop every key written concurrently by another
   * device. Deleting on `null` exists so shallow merge still has a way to
   * remove a key without a read-modify-replace race.
   *
   * ONE key inside `metadata` is reserved: `oidc`, which holds the identity
   * claims this Application asserts about the user to relying parties. The rest
   * of the object stays as free-form as it ever was. See lib/oidc-profile.ts
   * for why the namespace exists rather than a list of reserved claim names.
   */
  async updateSelf(args: {
    applicationId: string;
    endUserId: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<PublicEndUser> {
    // Re-read (and re-run the erasure gate) rather than trusting the caller's
    // copy: the merge below is computed from stored state, so it has to be
    // stored state we just looked at.
    const current = await authService.getById(args.applicationId, args.endUserId);

    const data: Prisma.EndUserUpdateInput = {};
    if (args.metadata === null) {
      // Clearing the whole object drops the reserved namespace with it, which
      // is a self-inflicted loss of the user's own claims, not an escalation —
      // they cannot write different ones.
      data.metadata = Prisma.DbNull;
    } else if (args.metadata !== undefined) {
      assertNoReservedMetadataKey(args.metadata);
      const base =
        current.metadata && typeof current.metadata === 'object' && !Array.isArray(current.metadata)
          ? (current.metadata as Record<string, unknown>)
          : {};
      const merged: Record<string, unknown> = { ...base };
      for (const [key, value] of Object.entries(args.metadata)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      assertMetadataWithinLimit(merged);
      data.metadata = merged as Prisma.InputJsonValue;
    }

    // Nothing to write — return the current record rather than bumping
    // `updatedAt` for a no-op request.
    if (Object.keys(data).length === 0) return current;

    // The WHERE is scoped to (id, applicationId) so that even if a token from
    // another Application somehow reached here, it matches zero rows instead of
    // writing across the tenant boundary. `updateMany` (not `update`) because
    // only it accepts a compound WHERE on non-unique columns.
    const result = await prisma.endUser.updateMany({
      where: { id: args.endUserId, applicationId: args.applicationId },
      data,
    });
    if (result.count !== 1) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_NOT_FOUND',
        message: `EndUser "${args.endUserId}" not found in this application.`,
        fix: 'Verify the user id and that the presented user token belongs to this Application.',
      });
    }

    return authService.getById(args.applicationId, args.endUserId);
  },
};
