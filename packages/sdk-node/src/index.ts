/**
 * @rekey.dev/node — server SDK for Rekey.
 *
 * One client instance per Application. Construct with the Application's
 * secret key (`rp_live_…` or `rp_test_…`) and the URL of your Rekey
 * deployment. Never ship the secret key to the browser — for browser code
 * use `@rekey.dev/react` with the Application's public key instead.
 *
 * @example Smoke-test your credentials
 * ```ts
 * import { Rekey } from "@rekey.dev/node";
 *
 * const rekey = new Rekey({
 *   apiUrl: process.env.RELIPAY_URL!,
 *   secretKey: process.env.RELIPAY_SECRET!,
 * });
 *
 * const me = await rekey.applications.me();
 * console.log(`Connected to "${me.name}" (${me.slug})`);
 * ```
 */

import type {
  ApplicationDto,
  AuthResultDto,
  JwkRsaPublic,
  JwksDto,
  ChangePasswordRequest,
  CheckoutResultDto,
  CouponDto,
  ConsumeCreditsRequest,
  ConsumeCreditsResultDto,
  CreateCheckoutRequest,
  CreditBalanceDto,
  CreditLedgerEntryDto,
  EndUserDto,
  ForgotPasswordRequest,
  ForgotPasswordResultDto,
  LicenseVerifyResultDto,
  MfaVerifyRequest,
  OAuthAuthServerMetadata,
  OAuthIntrospectionResponse,
  OrganizationDto,
  OrganizationInvitationDto,
  OrganizationMemberDto,
  OrganizationWithRoleDto,
  PlanDto,
  ProvidersListDto,
  RekeyErrorShape,
  ResetPasswordRequest,
  SignInOutcomeDto,
  SignInRequest,
  SignUpRequest,
  SubscriptionDto,
  UsageAggregateDto,
  UsageRecordDto,
  ValidateCouponRequest,
  ValidateCouponResultDto,
} from '@rekey.dev/shared-types';

// The canonical error class lives in shared-types; import it for internal use
// and re-export below so @rekey.dev/node's public surface is unchanged.
import { RekeyError } from '@rekey.dev/shared-types';

export type {
  ApplicationDto,
  EndUserDto,
  ApiKeyDto,
  AuthResultDto,
  MfaChallengeResultDto,
  MfaVerifyRequest,
  SignInOutcomeDto,
  SignInRequest,
  SignUpRequest,
  RefreshRequest,
  ForgotPasswordRequest,
  ForgotPasswordResultDto,
  ResetPasswordRequest,
  ChangePasswordRequest,
  PlanDto,
  SubscriptionDto,
  CreateCheckoutRequest,
  CheckoutResultDto,
  CouponDto,
  ValidateCouponRequest,
  ValidateCouponResultDto,
  CouponDiscountTypeValue,
  PlanIntervalType,
  PlanKindType,
  LicenseKindType,
  CreditReasonType,
  CreditBalanceDto,
  CreditLedgerEntryDto,
  ConsumeCreditsRequest,
  ConsumeCreditsResultDto,
  OrganizationDto,
  OrganizationWithRoleDto,
  OrganizationMemberDto,
  OrganizationInvitationDto,
  OrganizationRole,
  LicenseDto,
  LicenseStatusType,
  LicenseVerifyResultDto,
  UsageRecordDto,
  UsageAggregateDto,
  SubscriptionStatusType,
  RekeyErrorShape,
  AuthConfig,
  BillingConfig,
  BillingProvider,
  TokenAlg,
  JwkRsaPublic,
  JwksDto,
  OAuthIntrospectionResponse,
  OAuthAuthServerMetadata,
} from '@rekey.dev/shared-types';

/** Configuration for a Rekey client instance. */
export interface ReliPayConfig {
  /** Base URL of the Rekey API. e.g. `https://rekey.example.com` */
  apiUrl: string;
  /** Secret key for one Application — `rp_live_…` or `rp_test_…`. Never ship to the browser. */
  secretKey: string;
  /** Optional fetch override (test stubs, custom keep-alive agents, etc.). */
  fetch?: typeof fetch;
}

// RekeyError is the shared class (imported above) — re-exported so the public
// API name is preserved and `instanceof` is consistent with @rekey.dev/react.
export { RekeyError };

/**
 * Outbound webhook event registry — the events Rekey can POST to your app
 * (verify them with `verifyWebhookSignature` below). `WEBHOOK_EVENTS` carries
 * `{ name, description }` pairs for introspection/autocomplete;
 * `KNOWN_WEBHOOK_EVENTS` is just the names. Mirrors the API's registry exactly.
 *
 * @example
 * ```ts
 * import { WEBHOOK_EVENTS, isKnownWebhookEvent, type WebhookEventEnvelope } from '@rekey.dev/node';
 *
 * for (const e of WEBHOOK_EVENTS) console.log(`${e.name} — ${e.description}`);
 *
 * const event = req.body as WebhookEventEnvelope; // after verifyWebhookSignature(...)
 * if (event.type === 'subscription.activated') unlockPlan(event.data);
 * ```
 */
export { WEBHOOK_EVENTS, KNOWN_WEBHOOK_EVENTS, isKnownWebhookEvent } from '@rekey.dev/shared-types';
export type { WebhookEventType, WebhookEventEnvelope } from '@rekey.dev/shared-types';

/**
 * Top-level Rekey client. Auth and billing live as namespaces
 * (`rekey.applications`, `rekey.auth`, `rekey.billing`) so an agent
 * reading `rekey.` in an editor sees a discoverable surface.
 */
export class Rekey {
  private readonly apiUrl: string;
  private readonly secretKey: string;
  private readonly fetchImpl: typeof fetch;

  /** Operations on the calling Application itself. */
  public readonly applications: ApplicationsClient;
  /** Auth operations — sign-in, sign-up, sessions, passkeys, magic-link. */
  public readonly auth: AuthClient;
  /** Billing operations — plans, checkout, subscriptions, coupons. */
  public readonly billing: BillingClient;
  /** End-user organizations — create, invite, members, role changes. */
  public readonly organizations: OrganizationsClient;
  /** License key verification + activation. */
  public readonly licenses: LicensesClient;
  /** Usage metering — record events, aggregate windows. */
  public readonly usage: UsageClient;
  /** Prepaid credits — balance reads, idempotent drawdown, ledger. */
  public readonly credits: CreditsClient;
  /** MCP — validate Rekey-issued MCP tokens from your own MCP server. */
  public readonly mcp: McpClient;

  constructor(config: ReliPayConfig) {
    if (!config.apiUrl) {
      throw new RekeyError({
        code: 'CONFIG_MISSING_API_URL',
        message: 'Rekey client requires `apiUrl`.',
        fix: 'Pass `apiUrl: process.env.RELIPAY_URL` when constructing the client.',
      });
    }
    if (!config.secretKey || !config.secretKey.startsWith('rp_')) {
      throw new RekeyError({
        code: 'CONFIG_INVALID_SECRET_KEY',
        message: 'Rekey client requires a valid `secretKey` (starts with `rp_`).',
        fix: 'Get a key from the Rekey panel under Application → API Keys, then pass it as `secretKey`.',
      });
    }

    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.secretKey = config.secretKey;
    this.fetchImpl = config.fetch ?? fetch;

    this.applications = new ApplicationsClient(this);
    this.auth = new AuthClient(this);
    this.billing = new BillingClient(this);
    this.organizations = new OrganizationsClient(this);
    this.licenses = new LicensesClient(this);
    this.usage = new UsageClient(this);
    this.credits = new CreditsClient(this);
    this.mcp = new McpClient(this);
  }

  /** @internal */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const json = (await res.json().catch(() => ({}))) as
      | { success: true; data: T }
      | { success: false; error: RekeyErrorShape & { requestId?: string } };

    if (!res.ok || ('success' in json && json.success === false)) {
      const requestId = res.headers.get('x-request-id') ?? undefined;
      const err =
        'error' in json
          ? json.error
          : {
              code: 'UNKNOWN_ERROR',
              message: `Request failed with status ${res.status}.`,
              fix: 'Check the Rekey API logs for the matching request id.',
            };
      const resolvedRequestId =
        ('requestId' in err && err.requestId) || requestId;
      throw new RekeyError({
        ...err,
        statusCode: res.status,
        ...(resolvedRequestId !== undefined && { requestId: resolvedRequestId }),
      });
    }

    return (json as { success: true; data: T }).data;
  }

  /**
   * @internal Raw request for the non-enveloped OAuth/MCP endpoints — returns
   * the parsed JSON as-is (those endpoints emit standard OAuth shapes, not the
   * `{ success, data }` envelope). Throws `RekeyError` on non-2xx, mapping
   * the OAuth `{ error, error_description }` body when present.
   */
  async requestRaw<T>(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${this.secretKey}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof json.error === 'string' ? json.error : `HTTP_${res.status}`;
      const message =
        typeof json.error_description === 'string'
          ? json.error_description
          : `Request failed with status ${res.status}.`;
      throw new RekeyError({ code, message, statusCode: res.status });
    }
    return json as T;
  }
}

/**
 * MCP helpers for customers running their OWN MCP server behind Rekey auth.
 * The hosted MCP server (account tools) is consumed by MCP clients directly —
 * this client is for the "bring your own MCP server" path: validate incoming
 * Rekey-issued tokens, and read the OAuth metadata.
 */
class McpClient {
  private slugCache: string | null = null;
  constructor(private readonly client: Rekey) {}

  private async slug(): Promise<string> {
    if (this.slugCache) return this.slugCache;
    const app = await this.client.request<ApplicationDto>('GET', '/api/v1/me/');
    this.slugCache = app.slug;
    return app.slug;
  }

  /**
   * Validate an MCP access token (RFC 7662 introspection). Call this from your
   * own MCP server to authorize an incoming request. Authenticated with this
   * client's secret key.
   *
   * @example
   * ```ts
   * const result = await rekey.mcp.introspect(bearerToken);
   * if (!result.active) throw new Error('unauthorized');
   * const endUserId = result.sub;
   * ```
   */
  introspect(token: string): Promise<OAuthIntrospectionResponse> {
    return this.slug().then((slug) =>
      this.client.requestRaw<OAuthIntrospectionResponse>(
        'POST',
        `/api/v1/mcp/${slug}/oauth/introspect`,
        { token },
      ),
    );
  }

  /** Fetch this application's OAuth authorization-server metadata (RFC 8414). */
  metadata(): Promise<OAuthAuthServerMetadata> {
    return this.slug().then((slug) =>
      this.client.requestRaw<OAuthAuthServerMetadata>(
        'GET',
        `/api/v1/mcp/${slug}/.well-known/oauth-authorization-server`,
        undefined,
        false,
      ),
    );
  }
}

class ApplicationsClient {
  constructor(private readonly client: Rekey) {}

  /**
   * Verify credentials and fetch the calling Application. Use this as your
   * SDK smoke test — if it returns, your secret key is good and you're
   * pointed at the right Rekey deployment.
   *
   * @example
   * ```ts
   * const me = await rekey.applications.me();
   * console.log(`Connected to "${me.name}" (${me.slug})`);
   * ```
   *
   * @throws {RekeyError} with `code: "API_KEY_INVALID"` if the key is wrong/revoked/expired.
   */
  me(): Promise<ApplicationDto> {
    return this.client.request('GET', '/api/v1/me/');
  }
}

class AuthClient {
  constructor(private readonly client: Rekey) {}

  /**
   * Create a new end-user in the calling Application via email + password.
   * Returns the user and a JWT to use for subsequent per-user calls
   * (e.g. `getCurrentUser(token)`).
   *
   * @example
   * ```ts
   * const { endUser, token } = await rekey.auth.signUp({
   *   email: 'alice@example.com',
   *   password: 'correct-horse-battery-staple',
   * });
   * // store token in your session, return it to the browser, etc.
   * ```
   *
   * @throws {RekeyError} `EMAIL_ALREADY_EXISTS` (409) if the email is taken in this Application.
   * @throws {RekeyError} `PASSWORD_TOO_SHORT` (400) if shorter than the Application's `passwordMinLength`.
   * @throws {RekeyError} `AUTH_METHOD_DISABLED` (400) if the Application doesn't have `"password"` enabled.
   */
  signUp(input: SignUpRequest): Promise<AuthResultDto> {
    return this.client.request('POST', '/api/v1/auth/sign-up', input);
  }

  /**
   * Authenticate an existing end-user with email + password.
   *
   * Returns a discriminated union over `mfaRequired`:
   *   - `mfaRequired === false` → full `AuthResultDto` with access+refresh.
   *   - `mfaRequired === true`  → `mfaChallengeToken` (5-minute lifetime).
   *     Prompt the user for their TOTP / backup code and call
   *     `mfaVerify({ mfaChallengeToken, code })` to receive a real session.
   *
   * **Branch on `result.mfaRequired` before reading `accessToken`** — the
   * MFA-required branch has no session tokens.
   *
   * @throws {RekeyError} `INVALID_CREDENTIALS` (401) — single code on purpose.
   *   Don't try to distinguish wrong-email from wrong-password from the SDK side either.
   */
  signIn(input: SignInRequest): Promise<SignInOutcomeDto> {
    return this.client.request('POST', '/api/v1/auth/sign-in', input);
  }

  /**
   * Exchange an MFA challenge token + TOTP/backup code for a real session.
   * Use after `signIn` (or OAuth callback) returns `mfaRequired: true`.
   *
   * @throws {RekeyError} `MFA_CHALLENGE_INVALID` (401) if the token is
   *   forged, expired, or signed with a different secret.
   * @throws {RekeyError} `MFA_CHALLENGE_WRONG_APPLICATION` (401) if the
   *   token was issued under a different Application.
   * @throws {RekeyError} `MFA_CODE_INVALID` (401) if the code doesn't
   *   verify against the user's TOTP secret or remaining backup codes.
   */
  mfaVerify(input: MfaVerifyRequest): Promise<AuthResultDto> {
    return this.client.request('POST', '/api/v1/auth/mfa-verify', input);
  }

  /**
   * Request a magic-link sign-in email. Enumeration-safe: same response
   * shape whether the email exists or not. When the Application has
   * email transport configured, the link is sent and `magicLinkToken`
   * is null; otherwise the raw token is returned for you to forward.
   */
  requestMagicLink(input: {
    email: string;
    signInUrl?: string;
  }): Promise<{
    delivered: boolean;
    emailSent: boolean;
    magicLinkToken: string | null;
  }> {
    return this.client.request('POST', '/api/v1/auth/magic-link/request', input);
  }

  /**
   * Consume a magic-link token. Returns `SignInOutcome` — branch on
   * `mfaRequired` before reading `accessToken`. For MFA-enrolled users
   * the response carries `mfaChallengeToken` and you must complete via
   * `mfaVerify(...)`.
   */
  verifyMagicLink(input: { token: string }): Promise<SignInOutcomeDto> {
    return this.client.request('POST', '/api/v1/auth/magic-link/verify', input);
  }

  /**
   * Begin a passkey authentication ceremony. Returns the WebAuthn options
   * to forward to the browser (`navigator.credentials.get(...)`) along
   * with `expectedChallenge` — bind the challenge to your session and
   * pass both back via `verifyPasskeyAuthentication(...)`.
   */
  startPasskeyAuthentication(input?: { email?: string }): Promise<{
    options: unknown;
    expectedChallenge: string;
  }> {
    return this.client.request('POST', '/api/v1/auth/passkey/authenticate/start', input ?? {});
  }

  /**
   * Complete a passkey authentication. Returns the same `SignInOutcome`
   * shape as `signIn` — but passkeys are themselves a strong factor, so
   * `mfaRequired` will always be `false` in practice.
   */
  verifyPasskeyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
  }): Promise<SignInOutcomeDto> {
    return this.client.request('POST', '/api/v1/auth/passkey/authenticate/complete', input);
  }

  /**
   * Begin a passkey registration ceremony for an authenticated user.
   * Forward `options` to `navigator.credentials.create(...)`; store
   * `expectedChallenge` in session; POST both back via
   * `verifyPasskeyRegistration(...)`.
   */
  startPasskeyRegistration(accessToken: string): Promise<{
    options: unknown;
    expectedChallenge: string;
  }> {
    return this.client.request('POST', '/api/v1/auth/passkey/register/start', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  verifyPasskeyRegistration(
    accessToken: string,
    input: {
      response: unknown;
      expectedChallenge: string;
      deviceName?: string;
    },
  ): Promise<{ credentialId: string; deviceName: string | null }> {
    return this.client.request('POST', '/api/v1/auth/passkey/register/complete', input, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** List the user's registered passkeys. */
  listPasskeys(accessToken: string): Promise<
    Array<{
      id: string;
      credentialId: string;
      deviceName: string | null;
      lastUsedAt: string | null;
      createdAt: string;
    }>
  > {
    return this.client.request('GET', '/api/v1/auth/passkeys', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Remove a passkey. Returns `{deleted: false}` if the row doesn't belong to this user. */
  deletePasskey(accessToken: string, credentialRowId: string): Promise<{ deleted: boolean }> {
    return this.client.request(
      'DELETE',
      `/api/v1/auth/passkeys/${encodeURIComponent(credentialRowId)}`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  // End-user organization / team methods live on `rekey.organizations.*`
  // (OrganizationsClient) — the canonical, fuller surface. The earlier
  // duplicates here (createOrganization / listMyOrganizations /
  // inviteToOrganization / acceptOrganizationInvitation) were removed to
  // avoid two divergent copies of the same endpoints.

  /**
   * Resolve the end-user behind a presented access token.
   *
   * @throws {RekeyError} `USER_TOKEN_INVALID` (401) if expired/forged/wrong-secret.
   * @throws {RekeyError} `USER_TOKEN_WRONG_APPLICATION` (401) if the token was issued
   *   by a different Application than the calling secret key represents.
   */
  getCurrentUser(accessToken: string): Promise<EndUserDto & { activeOrganizationId: string | null }> {
    return this.client.request('GET', '/api/v1/users/me/', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Exchange a refresh token for a fresh {access, refresh} pair. The presented
   * refresh is revoked atomically — call this **once** and store the new
   * `refreshToken` from the response immediately.
   *
   * @throws {RekeyError} `REFRESH_TOKEN_REUSED` (401) if you replay an already-used token.
   *   This is a strong signal the original was leaked; treat as compromise.
   * @throws {RekeyError} `REFRESH_TOKEN_EXPIRED` (401) after the 30-day refresh window.
   */
  refresh(refreshToken: string): Promise<AuthResultDto> {
    // /auth/refresh returns the same shape as /auth/mfa-verify — always a
    // full session (refresh requires a prior MFA-verified session by
    // definition).
    return this.client.request('POST', '/api/v1/auth/refresh', { refreshToken });
  }

  /**
   * Revoke a refresh token. Idempotent — no-op for unknown tokens. The
   * access token paired with this refresh remains valid until its short
   * (15 min) expiry; for true "log out everywhere" semantics, also clear
   * the access token from your client.
   */
  signOut(refreshToken: string): Promise<{ signedOut: true }> {
    return this.client.request('POST', '/api/v1/auth/sign-out', { refreshToken });
  }

  /**
   * Request a password-reset token for an email. Always succeeds — never
   * tells you whether the email exists. **You must email the returned
   * `resetToken` to the user**: Rekey does not send email.
   *
   * @example
   * ```ts
   * const { resetToken } = await rekey.auth.requestPasswordReset({ email });
   * if (resetToken) await sendgrid.send({ to: email, subject: 'Reset', text: `link: ${url(resetToken)}` });
   * ```
   */
  requestPasswordReset(input: ForgotPasswordRequest): Promise<ForgotPasswordResultDto> {
    return this.client.request('POST', '/api/v1/auth/forgot-password', input);
  }

  /**
   * Consume a reset token + set a new password. Single-use. On success,
   * every refresh token for the user is revoked.
   *
   * @throws {RekeyError} `PASSWORD_RESET_TOKEN_INVALID` / `_USED` / `_EXPIRED` / `_WRONG_APPLICATION`
   * @throws {RekeyError} `PASSWORD_TOO_SHORT` if below the Application's `passwordMinLength`
   */
  resetPassword(input: ResetPasswordRequest): Promise<{ ok: true }> {
    return this.client.request('POST', '/api/v1/auth/reset-password', input);
  }

  /**
   * Authenticated password change. Pass the user's *current* access token.
   * On success, every refresh token for the user is revoked — other devices
   * are signed out.
   */
  changePassword(accessToken: string, input: ChangePasswordRequest): Promise<{ ok: true }> {
    return this.client.request('POST', '/api/v1/auth/change-password', input, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Revoke every refresh token for the calling user. "Sign out of all
   * devices." The caller's access token remains valid until 15-min expiry
   * — clear it client-side for full logout.
   */
  signOutEverywhere(accessToken: string): Promise<{ revokedCount: number }> {
    return this.client.request(
      'POST',
      '/api/v1/auth/sign-out-everywhere',
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Send (or re-send) an email-verification link to the current user.
   * If email transport is configured on the Application, Rekey sends
   * the email and `verificationToken` is null. Otherwise the raw token
   * is returned for the caller to forward via their own provider.
   *
   * Pass `verifyUrl` containing `{token}` to template the link target
   * (e.g. `https://app.example.com/verify?t={token}`).
   */
  sendVerificationEmail(
    accessToken: string,
    input?: { verifyUrl?: string },
  ): Promise<{ emailSent: boolean; verificationToken: string | null }> {
    return this.client.request('POST', '/api/v1/auth/send-verification', input ?? {}, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Consume an email-verification token. Single-use, 24-hour lifetime.
   * Marks `emailVerified: true` on the user record. Cross-Application
   * tokens are refused with `EMAIL_VERIFICATION_TOKEN_WRONG_APPLICATION`.
   */
  verifyEmail(input: { token: string }): Promise<{ verified: true; endUser: EndUserDto }> {
    return this.client.request('POST', '/api/v1/auth/verify-email', input);
  }

  // ---------- Active sessions ----------

  /**
   * List the current user's active sessions (live refresh tokens), newest
   * first. Each carries the User-Agent + IP captured at issue time and an
   * `id` you can pass to `revokeSession(...)`.
   */
  listSessions(accessToken: string): Promise<
    Array<{
      id: string;
      createdAt: string;
      expiresAt: string;
      userAgent: string | null;
      ip: string | null;
    }>
  > {
    return this.client.request('GET', '/api/v1/auth/sessions', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Revoke one session by id. Idempotent — `{ revoked: false }` if it isn't this user's. */
  revokeSession(accessToken: string, sessionId: string): Promise<{ revoked: boolean }> {
    return this.client.request(
      'DELETE',
      `/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  // ---------- MFA enrollment / management ----------
  //
  // The login-step verification is `mfaVerify(...)` above. These manage the
  // user's own TOTP enrollment + step-up challenges. Gated by the
  // Application's `authConfig.mfa` policy — calls return `MFA_NOT_ENABLED`
  // (403) when the policy is "off".

  /** MFA enrollment status for the current user, plus the Application's policy. */
  mfaStatus(accessToken: string): Promise<{
    enabled: boolean;
    remainingBackupCodes: number | null;
    policy: 'off' | 'optional' | 'required';
  }> {
    return this.client.request('GET', '/api/v1/auth/mfa/status', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Begin TOTP enrollment: mints a secret (as an `otpauthUrl` for the QR) and
   * 10 single-show backup codes. **Not enrolled until `confirmMfaSetup(...)`.**
   * Only SHA-256 hashes of the backup codes are stored — show them once.
   */
  mfaSetup(accessToken: string): Promise<{
    otpauthUrl: string;
    backupCodes: string[];
    warning: string;
  }> {
    return this.client.request('POST', '/api/v1/auth/mfa/setup', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Confirm enrollment by submitting the current 6-digit TOTP code. */
  confirmMfaSetup(accessToken: string, code: string): Promise<{ ok: true }> {
    return this.client.request('POST', '/api/v1/auth/mfa/setup-confirm', { code }, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Verify a TOTP or backup code as a step-up check (does NOT issue a session).
   * Backup codes are single-use — consumed on success. Returns `{ ok }`.
   */
  mfaChallenge(accessToken: string, code: string): Promise<{ ok: boolean }> {
    return this.client.request('POST', '/api/v1/auth/mfa/challenge', { code }, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Disable MFA for the current user. */
  disableMfa(accessToken: string): Promise<{ disabled: true }> {
    return this.client.request('POST', '/api/v1/auth/mfa/disable', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  // ---------- OAuth (social sign-in + account linking) ----------
  //
  // Sign-in flow (no user token): `startOAuth` → redirect the browser → your
  // server receives `code` → `completeOAuth` returns a SignInOutcome.
  // Linking flow (authenticated): `startOAuthLink` → `completeOAuthLink`.

  /**
   * Get the provider authorization URL to redirect the browser to. Pass an
   * unguessable `state` and verify it on return before calling `completeOAuth`.
   */
  startOAuth(provider: string, state: string): Promise<{ authorizationUrl: string }> {
    return this.client.request(
      'POST',
      `/api/v1/auth/oauth/${encodeURIComponent(provider)}/start`,
      { state },
    );
  }

  /**
   * Exchange the provider `code` for a Rekey session. Returns a
   * `SignInOutcome` — branch on `mfaRequired` before reading `accessToken`.
   * Verify the `state` CSRF value yourself before calling.
   */
  completeOAuth(provider: string, code: string): Promise<SignInOutcomeDto> {
    return this.client.request(
      'POST',
      `/api/v1/auth/oauth/${encodeURIComponent(provider)}/callback`,
      { code },
    );
  }

  /** List the OAuth providers linked to the current user. */
  listOAuthIdentities(accessToken: string): Promise<
    Array<{
      provider: string;
      providerAccountId: string;
      email: string | null;
      createdAt: string;
    }>
  > {
    return this.client.request('GET', '/api/v1/auth/oauth/identities', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Begin linking a provider to the *currently authenticated* user. */
  startOAuthLink(
    accessToken: string,
    provider: string,
    state: string,
  ): Promise<{ authorizationUrl: string }> {
    return this.client.request(
      'POST',
      `/api/v1/auth/oauth/${encodeURIComponent(provider)}/link/start`,
      { state },
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Complete an OAuth link — attaches the provider identity to the current
   * user. Refuses on unverified provider emails (account-takeover guard) or
   * when the provider account already belongs to a different user.
   */
  completeOAuthLink(
    accessToken: string,
    provider: string,
    code: string,
  ): Promise<{ provider: string; providerAccountId: string; alreadyLinked: boolean }> {
    return this.client.request(
      'POST',
      `/api/v1/auth/oauth/${encodeURIComponent(provider)}/link/complete`,
      { code },
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Remove a linked provider. Refuses with `OAUTH_UNLINK_WOULD_LOCK_OUT` (409)
   * if it would leave the account with no way to sign in.
   */
  unlinkOAuth(accessToken: string, provider: string): Promise<{ unlinked: boolean }> {
    return this.client.request(
      'DELETE',
      `/api/v1/auth/oauth/${encodeURIComponent(provider)}`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }
}

/** Optional offset pagination for list endpoints. The API caps these lists
 *  (default 50, max 100); pass `offset` to page beyond the first window. */
export interface ListPage {
  limit?: number;
  offset?: number;
}
function listQuery(page?: ListPage): string {
  if (!page) return '';
  const p = new URLSearchParams();
  if (page.limit !== undefined) p.set('limit', String(page.limit));
  if (page.offset !== undefined) p.set('offset', String(page.offset));
  const s = p.toString();
  return s ? `?${s}` : '';
}

class OrganizationsClient {
  constructor(private readonly client: Rekey) {}

  /** Create an organization; the calling user becomes the OWNER. */
  create(
    accessToken: string,
    input: { name: string; slug: string; metadata?: Record<string, unknown> },
  ): Promise<{ organization: OrganizationDto; membership: { id: string; role: 'OWNER' } }> {
    return this.client.request('POST', '/api/v1/users/me/organizations/', input, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** List organizations the calling user belongs to, with their role. The
   *  result is paginated (default 50, max 100); pass `page.offset` for more. */
  listMine(accessToken: string, page?: ListPage): Promise<OrganizationWithRoleDto[]> {
    return this.client.request('GET', `/api/v1/users/me/organizations/${listQuery(page)}`, undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Fetch one organization the caller belongs to. */
  get(accessToken: string, organizationId: string): Promise<OrganizationWithRoleDto> {
    return this.client.request(
      'GET',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /** Update org name / metadata. OWNER + ADMIN only. */
  update(
    accessToken: string,
    organizationId: string,
    input: { name?: string; metadata?: Record<string, unknown> },
  ): Promise<OrganizationDto> {
    return this.client.request(
      'PATCH',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}`,
      input,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /** List members of an organization the caller belongs to. Paginated
   *  (default 50, max 100); pass `page.offset` to page beyond the first window. */
  listMembers(
    accessToken: string,
    organizationId: string,
    page?: ListPage,
  ): Promise<OrganizationMemberDto[]> {
    return this.client.request(
      'GET',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}/members${listQuery(page)}`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Invite a user. Returns the raw token ONCE — surface via your own
   * email/share channel. OWNER + ADMIN only.
   */
  invite(
    accessToken: string,
    organizationId: string,
    input: { email: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' },
  ): Promise<{ invitation: OrganizationInvitationDto; token: string }> {
    return this.client.request(
      'POST',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}/invitations`,
      input,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /** Revoke a pending invitation. OWNER + ADMIN only. Idempotent. */
  revokeInvitation(
    accessToken: string,
    organizationId: string,
    invitationId: string,
  ): Promise<{ revoked: boolean }> {
    return this.client.request(
      'POST',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Change a member's role. OWNER manages anyone; ADMIN manages MEMBER
   * only. Last-OWNER guard refuses demoting the only OWNER.
   */
  setMemberRole(
    accessToken: string,
    organizationId: string,
    targetEndUserId: string,
    input: { role: 'OWNER' | 'ADMIN' | 'MEMBER' },
  ): Promise<{
    id: string;
    organizationId: string;
    endUserId: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
  }> {
    return this.client.request(
      'PATCH',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(targetEndUserId)}`,
      input,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Remove a member (or self). Refuses removing the last OWNER.
   *
   * Idempotent: `removed` is `false` when the target was not a member (e.g.
   * already removed) — a no-op removal is not an error. Branch on `removed`
   * rather than assuming it is always `true`.
   */
  removeMember(
    accessToken: string,
    organizationId: string,
    targetEndUserId: string,
  ): Promise<{ removed: boolean }> {
    return this.client.request(
      'DELETE',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(targetEndUserId)}`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Self-leave. An OWNER cannot leave (payment + benefits are tied to the
   * owner — `ORGANIZATION_OWNER_CANNOT_LEAVE`); transfer ownership via support
   * first, or demote yourself to ADMIN if there is another OWNER.
   */
  leave(accessToken: string, organizationId: string): Promise<{ removed: boolean }> {
    return this.client.request(
      'POST',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}/leave`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Accept an organization invitation by raw token. Refuses cross-
   * Application invitations. Idempotent if the caller is already a member.
   */
  acceptInvitation(
    accessToken: string,
    input: { token: string },
  ): Promise<{
    membership: {
      id: string;
      organizationId: string;
      role: 'OWNER' | 'ADMIN' | 'MEMBER';
    };
  }> {
    return this.client.request(
      'POST',
      '/api/v1/auth/organizations/accept-invitation',
      input,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Make `organizationId` the active org for this session (member-only).
   * Returns a fresh {accessToken, refreshToken} pair carrying the active org —
   * **store both**. Subsequent entitlement reads (`billing.getEntitlements`)
   * then default to this org's view + shared pool without passing
   * `organizationId` explicitly. The active org survives token refresh until
   * you switch again, clear it, or leave the org.
   */
  switch(accessToken: string, organizationId: string): Promise<AuthResultDto> {
    return this.client.request(
      'POST',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}/switch`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * Clear the active org — switch the session back to the personal pool.
   * Returns a fresh token pair (no active org); **store both**.
   */
  clearActive(accessToken: string): Promise<AuthResultDto> {
    return this.client.request(
      'POST',
      '/api/v1/users/me/organizations/clear-active-organization',
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }
}

class LicensesClient {
  constructor(private readonly client: Rekey) {}

  /**
   * Verify a license key + record an activation for this machine. Call
   * once at app startup; you'll get a deterministic body (`ok=false` for
   * invalid licenses — never an HTTP error — so your software can loop
   * on the result without try/catch noise).
   *
   * `machineFingerprint` should be a stable identifier you derive client-
   * side (hostname + OS + mac address, hashed). The same fingerprint
   * across re-verifications does NOT consume a new seat.
   *
   * @example
   * ```ts
   * const result = await rekey.licenses.verify({
   *   key,
   *   machineFingerprint,
   *   label: 'Adam\'s MacBook',
   * });
   * if (!result.ok) showLicenseError(result.reason);
   * ```
   */
  verify(input: {
    key: string;
    machineFingerprint: string;
    label?: string;
  }): Promise<LicenseVerifyResultDto> {
    return this.client.request('POST', '/api/v1/licenses/verify', input);
  }
}

class UsageClient {
  constructor(private readonly client: Rekey) {}

  /**
   * Record a usage event against a named meter. `quantity` can be
   * negative to credit back (e.g. refunds). `occurredAt` defaults to
   * server time; pass an ISO string when ingesting historical events.
   */
  record(input: {
    meterSlug: string;
    quantity: number;
    /** Attribute to an end-user, or an `organizationId` (shared org pool), or
     *  neither (app-level usage). Pass at most one subject. */
    endUserId?: string;
    organizationId?: string;
    occurredAt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<UsageRecordDto> {
    return this.client.request('POST', '/api/v1/usage/record', input);
  }

  /**
   * Sum recorded quantity for a meter, optionally bounded by a time window
   * and/or scoped to a subject (`endUserId` or `organizationId`). Drives
   * "you've used X of your Y quota" displays.
   */
  aggregate(input: {
    meterSlug: string;
    from?: string;
    to?: string;
    endUserId?: string;
    organizationId?: string;
  }): Promise<UsageAggregateDto> {
    const params = new URLSearchParams();
    params.set('meterSlug', input.meterSlug);
    if (input.from) params.set('from', input.from);
    if (input.to) params.set('to', input.to);
    if (input.endUserId) params.set('endUserId', input.endUserId);
    if (input.organizationId) params.set('organizationId', input.organizationId);
    return this.client.request('GET', `/api/v1/usage/aggregate?${params.toString()}`);
  }
}

/**
 * Prepaid credits — the "lead pack" / pay-as-you-go drawdown model. The
 * customer's backend grants credits (by selling a CREDIT-kind plan, which
 * grants automatically on payment) and draws them down per unit consumed.
 *
 * All calls are server-to-server (secret key) and scoped to an end-user id.
 */
/**
 * A credit subject — pass `endUserId` for a personal balance, or
 * `organizationId` for a shared org pool (owner+beneficiary billing).
 */
export type CreditSubject = { endUserId: string } | { organizationId: string };

function creditSubjectQuery(subject: CreditSubject): URLSearchParams {
  const p = new URLSearchParams();
  if ('organizationId' in subject) p.set('organizationId', subject.organizationId);
  else p.set('endUserId', subject.endUserId);
  return p;
}

class CreditsClient {
  constructor(private readonly client: Rekey) {}

  /** Current spendable balance for a subject (end-user or org); 0 if none. */
  getBalance(subject: CreditSubject): Promise<CreditBalanceDto> {
    return this.client.request('GET', `/api/v1/credits/balance?${creditSubjectQuery(subject)}`);
  }

  /**
   * Deduct credits from a subject (end-user or org pool). Throws `RekeyError`
   * `code: "CREDITS_INSUFFICIENT"` (HTTP 402) when the balance is too low.
   *
   * Pass `idempotencyKey` (e.g. the lead id) so a retried call never
   * double-charges — a repeat returns the original result with `applied: false`.
   */
  consume(input: ConsumeCreditsRequest & CreditSubject): Promise<ConsumeCreditsResultDto> {
    return this.client.request('POST', '/api/v1/credits/consume', input);
  }

  /**
   * Ledger entries for a subject, newest first. Pass `offset` to page back
   * through the full append-only history (the ledger grows for the life of a
   * subject); `limit` is capped at 200 server-side.
   */
  listLedger(
    subject: CreditSubject,
    limit?: number,
    offset?: number,
  ): Promise<CreditLedgerEntryDto[]> {
    const params = new URLSearchParams(creditSubjectQuery(subject));
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    return this.client.request('GET', `/api/v1/credits/ledger?${params.toString()}`);
  }
}

/** What an end-user (or org) is entitled to right now — from active subs. */
export interface EntitlementsDto {
  /** Feature flags + numeric limits, keyed by code. Gate your app on these. */
  features: Record<string, boolean | number | string>;
  /** The raw resolved entitlement rows (all kinds). */
  entitlements: Array<{
    kind: 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';
    key: string;
    valueType: 'BOOL' | 'INT' | 'STRING' | null;
    value: string | null;
    quantity: number | null;
    licenseKind: 'PERPETUAL' | 'TIMED' | 'SEATS' | null;
    rollover: boolean;
  }>;
  /** Live credit balance for the resolved subject. */
  creditBalance: number;
}

/**
 * Verify the HMAC signature on an inbound webhook from Rekey. Returns
 * `true` only when (a) the timestamp is fresh (within `toleranceSeconds`,
 * default 300) AND (b) the signature matches a constant-time compare.
 *
 * Use against the `X-Rekey-Signature` header and the raw request body
 * BYTES (not the parsed JSON — any reserialization breaks the HMAC).
 *
 * @example
 * ```ts
 * import { verifyWebhookSignature } from '@rekey.dev/node';
 *
 * app.post('/webhooks/rekey', { config: { rawBody: true } }, (req) => {
 *   const ok = verifyWebhookSignature({
 *     header: req.headers['x-rekey-signature'] as string,
 *     payload: req.rawBody!,
 *     secret: process.env.RELIPAY_WEBHOOK_SECRET!,
 *   });
 *   if (!ok) return reply.status(401).send({ error: 'bad signature' });
 *   // safe to act on req.body
 * });
 * ```
 */
export function verifyWebhookSignature(args: {
  header: string | null | undefined;
  payload: string | Buffer;
  secret: string;
  toleranceSeconds?: number;
  now?: () => number;
}): boolean {
  if (!args.header) return false;
  const tolerance = (args.toleranceSeconds ?? 300) * 1000;
  const nowMs = args.now ? args.now() : Date.now();

  const parts = args.header.split(',').reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split('=', 2);
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowMs - t * 1000) > tolerance) return false;

  // Lazy-load Node crypto so the SDK still runs in edge runtimes that
  // don't bundle it (signature verification is the only place we need
  // crypto — everything else uses fetch).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac, timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
  const body =
    typeof args.payload === 'string' ? Buffer.from(args.payload, 'utf8') : args.payload;
  const signed = `${t}.${body.toString('utf8')}`;
  const expected = createHmac('sha256', args.secret).update(signed).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ============================================================================
// Offline access-token verification (JWKS / RS256)
// ============================================================================

/** Verified claims of an RS256 end-user access token. */
export interface VerifiedAccessTokenClaims {
  /** Always `"eu_access"` — other token types are refused. */
  typ: 'eu_access';
  /** EndUser id. */
  sub: string;
  /** Application the token is bound to — check it against YOUR application id. */
  applicationId: string;
  /** Active organization id, when the session is acting as an org. */
  oid?: string;
  /** Operator id when this is an impersonation session (treat with care). */
  imp?: string;
  /** App `tokenGeneration` at mint time (the API checks this; offline can't). */
  gen?: number;
  iat: number;
  exp: number;
}

export interface VerifyAccessTokenOptions {
  /**
   * URL of the deployment's JWKS — `https://<your-rekey>/.well-known/jwks.json`.
   * Fetched lazily and cached in-process for `cacheTtlMs` (default 5 minutes);
   * an unknown `kid` triggers one immediate refetch so freshly rotated keys
   * are picked up without waiting out the TTL.
   */
  jwksUrl?: string;
  /** Pre-fetched key set — skips all network access. Takes precedence over `jwksUrl`. */
  jwks?: JwksDto;
  /** Optional fetch override (test stubs, custom agents). */
  fetch?: typeof fetch;
  /** JWKS cache lifetime in ms when using `jwksUrl`. Default 300 000 (5 min). */
  cacheTtlMs?: number;
  /** Clock override for tests. Returns ms since epoch. */
  now?: () => number;
}

const jwksCache = new Map<string, { jwks: JwksDto; fetchedAt: number }>();

/** @internal Test hook — drop cached JWKS responses. */
export function _clearJwksCacheForTests(): void {
  jwksCache.clear();
}

function b64urlJson<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

async function loadJwks(
  options: VerifyAccessTokenOptions,
  forceRefetch: boolean,
): Promise<JwksDto> {
  if (options.jwks) return options.jwks;
  const url = options.jwksUrl;
  if (!url) {
    throw new RekeyError({
      code: 'CONFIG_MISSING_JWKS',
      message: 'verifyAccessToken requires either `jwksUrl` or a pre-fetched `jwks`.',
      fix: 'Pass `jwksUrl: "https://<your-rekey>/.well-known/jwks.json"`.',
    });
  }
  const ttl = options.cacheTtlMs ?? 5 * 60 * 1000;
  const cached = jwksCache.get(url);
  if (cached && !forceRefetch && Date.now() - cached.fetchedAt <= ttl) return cached.jwks;

  const fetchImpl = options.fetch ?? fetch;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new RekeyError({
      code: 'JWKS_FETCH_FAILED',
      message: `Fetching the JWKS from ${url} failed with status ${res.status}.`,
      fix: 'Check the URL points at your Rekey deployment’s /.well-known/jwks.json.',
      statusCode: res.status,
    });
  }
  const jwks = (await res.json()) as JwksDto;
  if (!jwks || !Array.isArray(jwks.keys)) {
    throw new RekeyError({
      code: 'JWKS_FETCH_FAILED',
      message: 'The JWKS endpoint did not return a `{ keys: [...] }` body.',
      fix: 'Check the URL points at /.well-known/jwks.json, not another route.',
    });
  }
  jwksCache.set(url, { jwks, fetchedAt: Date.now() });
  return jwks;
}

/**
 * Verify an end-user ACCESS token **offline** — no round-trip to the Rekey
 * API. Works only for Applications that opted into RS256 tokens
 * (`authConfig.tokenAlg = "RS256"`, Panel → Application → Auth); the default
 * HS256 tokens are symmetric and can only be verified by the API itself
 * (use `rekey.auth.getCurrentUser(token)` for those).
 *
 * Checks performed (same posture as the API's verifier):
 *   - header `alg` must be `RS256` and `kid` must exist in the JWKS —
 *     a strict allowlist, immune to alg-confusion;
 *   - RSA-SHA256 signature against that public key;
 *   - `exp` in the future, `typ === "eu_access"` (refresh/MFA/MCP tokens
 *     are refused), `sub` + `applicationId` present.
 *
 * What it CANNOT check offline: the app's `tokenGeneration` kill-switch and
 * user deletion. The 15-minute access lifetime bounds both; for hard
 * revocation guarantees keep using `auth.getCurrentUser`.
 *
 * Node-only (uses `node:crypto`). Returns the verified claims; throws
 * `RekeyError` on any failure.
 *
 * @example Express/Fastify middleware at the edge
 * ```ts
 * import { verifyAccessToken } from '@rekey.dev/node';
 *
 * const claims = await verifyAccessToken(req.headers['x-rekey-user-token'], {
 *   jwksUrl: 'https://rekey.example.com/.well-known/jwks.json',
 * });
 * if (claims.applicationId !== MY_APP_ID) throw new Error('wrong app');
 * req.userId = claims.sub;
 * ```
 *
 * @throws {RekeyError} `TOKEN_ALG_NOT_RS256` — token is HS256 (app hasn't opted in) or another alg.
 * @throws {RekeyError} `TOKEN_KID_UNKNOWN` — `kid` not in the JWKS (forged, or key deleted).
 * @throws {RekeyError} `USER_TOKEN_EXPIRED` — `exp` passed; refresh the session.
 * @throws {RekeyError} `USER_TOKEN_INVALID` — malformed, bad signature, or wrong `typ`.
 */
export async function verifyAccessToken(
  token: string,
  options: VerifyAccessTokenOptions,
): Promise<VerifiedAccessTokenClaims> {
  const invalid = (message: string): RekeyError =>
    new RekeyError({
      code: 'USER_TOKEN_INVALID',
      message,
      fix: 'Have the user sign in again to obtain a fresh token.',
      statusCode: 401,
    });

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw invalid('The token is not a three-part JWT.');
  }

  let header: { alg?: unknown; kid?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw invalid('The token header/payload is not valid base64url JSON.');
  }

  // Strict alg allowlist — this helper verifies RS256 ONLY. HS256 tokens are
  // symmetric (the verifying key can also MINT tokens), so they are never
  // verified client-side.
  if (header.alg !== 'RS256') {
    throw new RekeyError({
      code: 'TOKEN_ALG_NOT_RS256',
      message: `Offline verification supports RS256 tokens only (got alg=${String(header.alg)}).`,
      fix: 'Enable RS256 for the Application (authConfig.tokenAlg) or verify via auth.getCurrentUser().',
      statusCode: 401,
    });
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw invalid('RS256 token is missing the `kid` header.');
  }

  // kid lookup, with one forced refetch on miss (key rotated in since the
  // cached copy was fetched).
  let jwks = await loadJwks(options, false);
  let jwk: JwkRsaPublic | undefined = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk && options.jwksUrl && !options.jwks) {
    jwks = await loadJwks(options, true);
    jwk = jwks.keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) {
    throw new RekeyError({
      code: 'TOKEN_KID_UNKNOWN',
      message: `No JWKS key matches the token's kid (${header.kid}).`,
      fix: 'The token may be forged, or its signing key was deleted after rotation. Re-authenticate the user.',
      statusCode: 401,
    });
  }

  // Lazy-load node:crypto (same posture as verifyWebhookSignature) — keeps
  // the import graph clean for bundlers that tree-shake this helper away.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPublicKey, verify } = require('node:crypto') as typeof import('node:crypto');
  let signatureOk = false;
  try {
    const publicKey = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
    signatureOk = verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw invalid('The token signature does not verify against the JWKS key.');

  // Claims — mirror the API's verifier: typ is load-bearing, exp is enforced.
  if (payload.typ !== 'eu_access') {
    throw invalid(`Token typ is ${JSON.stringify(payload.typ)}, expected "eu_access".`);
  }
  if (typeof payload.sub !== 'string' || typeof payload.applicationId !== 'string') {
    throw invalid('Token is missing the sub/applicationId claims.');
  }
  const nowSec = Math.floor((options.now ? options.now() : Date.now()) / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new RekeyError({
      code: 'USER_TOKEN_EXPIRED',
      message: 'The access token has expired.',
      fix: 'Refresh the session (auth.refresh) or have the user sign in again.',
      statusCode: 401,
    });
  }

  return payload as unknown as VerifiedAccessTokenClaims;
}

class BillingClient {
  constructor(private readonly client: Rekey) {}

  /**
   * List the calling Application's active plans. Public — pricing pages
   * typically render straight from this. Application API key only; no
   * user JWT needed.
   *
   * `amount` is in the smallest currency unit (cents/paise/sen) — never
   * a float. Format on display: `${amount / 100} ${currency}`.
   */
  getPlans(): Promise<PlanDto[]> {
    return this.client.request('GET', '/api/v1/billing/plans');
  }

  /**
   * Fetch the current end-user's active subscription, or `null` if they
   * have none. Returns the most recent ACTIVE / PENDING / PAST_DUE row.
   *
   * Pass the user's access token (the SDK puts it in `X-Rekey-User-Token`).
   */
  getSubscription(accessToken: string): Promise<SubscriptionDto | null> {
    return this.client.request('GET', '/api/v1/billing/subscription', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Start a hosted-checkout session. Returns the URL to redirect the user
   * to and the local PENDING Subscription row. Subscription activation
   * happens via the provider's webhook — not synchronously here.
   *
   * Pass `couponCode` to apply a discount. The whole checkout fails if the
   * coupon doesn't validate (typed `RekeyError` with the precise reason).
   *
   * If the Application's billing subject is **org** (Panel → Application →
   * Billing → Subject), an individual can't hold a subscription — you MUST
   * pass `organizationId` of a team the user owns/admins. Omitting it throws
   * `RekeyError` `code: "BILLING_ORGANIZATION_REQUIRED"`.
   *
   * @example
   * ```ts
   * const { url, discountAmount } = await rekey.billing.createCheckout(userAccessToken, {
   *   planSlug: 'pro_monthly',
   *   successUrl: 'https://yourapp.com/billing?status=ok',
   *   cancelUrl:  'https://yourapp.com/billing?status=cancel',
   *   couponCode: 'LAUNCH50', // optional
   * });
   * res.redirect(url);
   * ```
   */
  createCheckout(
    accessToken: string,
    input: CreateCheckoutRequest & { couponCode?: string },
  ): Promise<CheckoutResultDto> {
    return this.client.request('POST', '/api/v1/billing/checkout', input, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Validate a coupon for the current user against a plan, *without*
   * applying it. Render "$50 off" on a pricing page before submit.
   *
   * @throws {RekeyError} with one of `COUPON_NOT_FOUND` / `COUPON_INACTIVE`
   *   / `COUPON_NOT_YET_STARTED` / `COUPON_EXPIRED` / `COUPON_NOT_APPLICABLE`
   *   / `COUPON_CURRENCY_MISMATCH` / `COUPON_REDEMPTION_LIMIT_REACHED` /
   *   `COUPON_USER_LIMIT_REACHED`. Surface the message + fix to the user.
   */
  validateCoupon(
    accessToken: string,
    input: ValidateCouponRequest,
  ): Promise<ValidateCouponResultDto> {
    return this.client.request('POST', '/api/v1/billing/coupons/validate', input, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * List the billing providers configured + enabled for this Application,
   * in the order the geo router would prefer them. Forward the end-user's
   * `country` (ISO 3166-1 alpha-2) when you have it — the panel/SDK will
   * surface India-specific providers (Razorpay) for IN-country users, etc.
   *
   * Returns the resolved country (echoed back from the server's view of
   * `CF-IPCountry` etc.) plus the ordered provider list. Use this to render
   * a "Pay with..." picker on your pricing page.
   */
  getProviders(country?: string): Promise<ProvidersListDto> {
    const headers: Record<string, string> = {};
    if (country) headers['x-country'] = country.toUpperCase();
    return this.client.request('GET', '/api/v1/billing/providers', undefined, headers);
  }

  /**
   * Resolve the calling end-user's current entitlements — feature flags +
   * limits, the live credit balance, and the raw entitlement list, unioned
   * across their active subscriptions (and subscriptions of orgs they belong
   * to). Pass `{ organizationId }` (member-only) for that org's view + shared
   * pool. Gate your app's features on `features`.
   *
   * @example
   * ```ts
   * const { features } = await rekey.billing.getEntitlements(userAccessToken);
   * if (features.advanced_reporting) renderReportingTab();
   * ```
   */
  getEntitlements(accessToken: string, opts?: { organizationId?: string }): Promise<EntitlementsDto> {
    const qs = opts?.organizationId
      ? `?organizationId=${encodeURIComponent(opts.organizationId)}`
      : '';
    return this.client.request('GET', `/api/v1/billing/entitlements${qs}`, undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }
}
