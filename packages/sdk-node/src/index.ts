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
 *   apiUrl: process.env.REKEY_URL!,
 *   secretKey: process.env.REKEY_SECRET!,
 * });
 *
 * const me = await rekey.applications.me();
 * console.log(`Connected to "${me.name}" (${me.slug})`);
 * ```
 */

import type {
  ApplicationDto,
  AuthResultDto,
  ListPage,
  Paged,
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
// and re-export below so @rekey.dev/node's public surface is unchanged. The
// `/error` subpath is the zod-free module the class actually lives in — same
// class object the barrel re-exports, so `instanceof` is identical.
import { RekeyError } from '@rekey.dev/shared-types/error';

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

/**
 * Default per-request deadline, in milliseconds. Matches the timeout the Rekey
 * API itself uses when it POSTs your outbound webhooks.
 *
 * Without a deadline the effective timeout is undici's `headersTimeout` — five
 * minutes — so a single unreachable Rekey deployment can pin one of your
 * request handlers for that long. Ten seconds is long enough for any endpoint
 * this SDK calls and short enough to fail a page instead of hanging it.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Configuration for a Rekey client instance. */
export interface RekeyConfig {
  /** Base URL of the Rekey API. e.g. `https://rekey.example.com` */
  apiUrl: string;
  /** Secret key for one Application — `rp_live_…` or `rp_test_…`. Never ship to the browser. */
  secretKey: string;
  /** Optional fetch override (test stubs, custom keep-alive agents, etc.). */
  fetch?: typeof fetch;
  /**
   * Deadline for every request this client makes, in milliseconds.
   * Default {@link DEFAULT_TIMEOUT_MS} (10 000). Pass `0` to disable — only do
   * that if something upstream of you already bounds the call.
   *
   * On expiry the promise rejects with a `RekeyError` whose code is
   * `REQUEST_TIMEOUT`. Override per call with `timeoutMs` in the call options.
   */
  timeoutMs?: number | undefined;
  /**
   * Client-wide abort signal — aborting it cancels every in-flight request
   * (server shutdown, request-scoped cancellation). Composed with, not
   * replaced by, any per-call `signal`.
   */
  signal?: AbortSignal | undefined;
}

/**
 * Per-call overrides. Deliberately an options object rather than positional
 * parameters: this is the shape frozen at 2.0.0, and a new knob has to be
 * addable without a new overload.
 */
export interface RekeyRequestOptions {
  /** JSON request body. Omit for GET/DELETE — a present body sets `Content-Type`. */
  body?: unknown;
  /** Extra headers, merged over the SDK's own (`Authorization`, `Content-Type`). */
  headers?: Record<string, string> | undefined;
  /** Deadline for this one call, in ms. Overrides the client's. `0` disables. */
  timeoutMs?: number | undefined;
  /** Abort signal for this one call. Composed with the client's signal and the deadline. */
  signal?: AbortSignal | undefined;
}

/** The subset of {@link RekeyRequestOptions} every wrapped method accepts. */
export interface RekeyCallOptions {
  /** Deadline for this one call, in ms. Overrides the client's. `0` disables. */
  timeoutMs?: number | undefined;
  /** Abort signal for this one call. Composed with the client's signal and the deadline. */
  signal?: AbortSignal | undefined;
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
 * Would `cancelSubscription`'s default (`atPeriodEnd: true`) actually leave
 * this subscriber the rest of the period they paid for?
 *
 * Exported because a cancel confirmation has to say which outcome the customer
 * is about to get, and it has to say so BEFORE the call — there is no response
 * to read it off. It is the same function the API decides from, not a
 * description of it, so a UI built on it cannot promise a behaviour the server
 * does not have. See its docblock for the cases that still end immediately.
 *
 * @example
 * ```ts
 * const sub = await rekey.billing.getSubscription(token);
 * const message = sub && cancelsAtPeriodEnd(sub)
 *   ? `You keep access until ${sub.currentPeriodEnd}.`
 *   : 'Cancelling takes effect straight away.';
 * ```
 */
export { cancelsAtPeriodEnd } from '@rekey.dev/shared-types';
export type { CancellationTimingInput } from '@rekey.dev/shared-types';

/**
 * Top-level Rekey client. Auth and billing live as namespaces
 * (`rekey.applications`, `rekey.auth`, `rekey.billing`) so an agent
 * reading `rekey.` in an editor sees a discoverable surface.
 */
export class Rekey {
  private readonly apiUrl: string;
  private readonly secretKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly config: RekeyConfig;

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

  constructor(config: RekeyConfig) {
    if (!config.apiUrl) {
      throw new RekeyError({
        code: 'CONFIG_MISSING_API_URL',
        message: 'Rekey client requires `apiUrl`.',
        fix: 'Pass `apiUrl: process.env.REKEY_URL` when constructing the client.',
      });
    }
    if (!config.secretKey || !config.secretKey.startsWith('rp_')) {
      throw new RekeyError({
        code: 'CONFIG_INVALID_SECRET_KEY',
        message: 'Rekey client requires a valid `secretKey` (starts with `rp_`).',
        fix: 'Get a key from the Rekey panel under Application → API Keys, then pass it as `secretKey`.',
      });
    }

    this.config = config;
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.secretKey = config.secretKey;
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.signal = config.signal;

    this.applications = new ApplicationsClient(this);
    this.auth = new AuthClient(this);
    this.billing = new BillingClient(this);
    this.organizations = new OrganizationsClient(this);
    this.licenses = new LicensesClient(this);
    this.usage = new UsageClient(this);
    this.credits = new CreditsClient(this);
    this.mcp = new McpClient(this);
  }

  /**
   * A clone of this client with different call options — the per-call knob for
   * every wrapped method.
   *
   * Each namespace method (`billing.getPlans()`, `auth.signIn()`, …) has a
   * fixed signature, so scoping one call is done by scoping the client rather
   * than by threading an options argument through sixty-odd methods:
   *
   * @example Give one call a tighter deadline
   * ```ts
   * const plans = await rekey.with({ timeoutMs: 2_000 }).billing.getPlans();
   * ```
   *
   * @example Tie every Rekey call to an inbound request's lifetime
   * ```ts
   * app.get('/me', async (req, res) => {
   *   const scoped = rekey.with({ signal: AbortSignal.any([req.signal]) });
   *   res.json(await scoped.auth.getCurrentUser(token));
   * });
   * ```
   *
   * Cheap — it rebuilds the namespace objects, holds no connections, and
   * shares the same `fetch`.
   */
  with(options: RekeyCallOptions): Rekey {
    const signal =
      options.signal && this.signal
        ? AbortSignal.any([this.signal, options.signal])
        : (options.signal ?? this.signal);
    return new Rekey({
      ...this.config,
      timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
      ...(signal !== undefined && { signal }),
    });
  }

  /**
   * Call a Rekey endpoint this SDK does not wrap yet.
   *
   * This is a **supported** escape hatch, not an internal: when the API grows a
   * route before the SDK does, use this instead of hand-rolling `fetch` — you
   * keep the auth header, the `{ success, data }` unwrapping, the `RekeyError`
   * mapping (including transport failures) and the deadline. It takes an
   * options object precisely so a future knob does not need a new overload.
   *
   * Prefer a namespace method when one exists; those carry the endpoint's real
   * types, this returns whatever `T` you claim.
   *
   * @example
   * ```ts
   * const seats = await rekey.request<{ used: number }>('GET', '/api/v1/seats');
   *
   * await rekey.request('POST', '/api/v1/seats', {
   *   body: { count: 5 },
   *   timeoutMs: 30_000,
   * });
   * ```
   *
   * @throws {RekeyError} the server's error envelope, or `REQUEST_TIMEOUT` /
   * `REQUEST_ABORTED` / `NETWORK_ERROR` when the request never got an answer.
   */
  request<T>(method: string, path: string, options?: RekeyRequestOptions): Promise<T> {
    return this.send<T>(method, path, options?.body, options?.headers, options);
  }

  /**
   * @internal Positional workhorse behind {@link request}. Every wrapped method
   * calls this; it stays positional because it is not part of the published
   * surface (see `stripInternal` in tsconfig).
   */
  async send<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string> | undefined,
    options?: RekeyCallOptions,
  ): Promise<T> {
    const res = await this.fetchWithDeadline(
      `${this.apiUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      method,
      path,
      options,
    );

    const json = (await this.readJson(res, method, path, options)) as
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
    options?: RekeyCallOptions,
  ): Promise<T> {
    const res = await this.fetchWithDeadline(
      `${this.apiUrl}${path}`,
      {
        method,
        headers: {
          ...(auth ? { Authorization: `Bearer ${this.secretKey}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      method,
      path,
      options,
    );
    const json = (await this.readJson(res, method, path, options)) as Record<string, unknown>;
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

  /**
   * @internal The one place `fetch` is called. Applies the deadline, composes
   * the caller's signals, and turns anything the transport throws into a
   * `RekeyError` — without this, `ECONNREFUSED` escaped as a bare `TypeError`
   * and slipped straight through the documented
   * `catch (e) { if (e instanceof RekeyError) … }` pattern.
   */
  private async fetchWithDeadline(
    url: string,
    init: RequestInit,
    method: string,
    path: string,
    options?: RekeyCallOptions,
  ): Promise<Response> {
    const deadline = createDeadline(
      options?.timeoutMs ?? this.timeoutMs,
      this.signal,
      options?.signal,
    );
    try {
      return await this.fetchImpl(url, {
        ...init,
        ...(deadline.signal ? { signal: deadline.signal } : {}),
      });
    } catch (cause) {
      throw transportError(cause, deadline, method, path);
    }
  }

  /**
   * @internal Read the JSON body under the same deadline. A body that never
   * finishes streaming is just as hanging as headers that never arrive, and a
   * non-JSON body still degrades to `{}` the way it always did.
   */
  private async readJson(
    res: Response,
    method: string,
    path: string,
    options?: RekeyCallOptions,
  ): Promise<unknown> {
    try {
      return await res.json();
    } catch (cause) {
      if (isAbortError(cause)) {
        throw transportError(
          cause,
          createDeadline(options?.timeoutMs ?? this.timeoutMs, this.signal, options?.signal),
          method,
          path,
        );
      }
      return {};
    }
  }
}

/**
 * The composed abort signal for one request, plus the pieces needed to say
 * *why* it aborted. `AbortSignal.any` collapses them into one signal but
 * forgets which one fired, and "the request timed out" versus "you cancelled
 * it" versus "the host is unreachable" are three different bugs.
 */
interface Deadline {
  signal: AbortSignal | undefined;
  timeoutMs: number;
  /** The deadline's own signal — set only when a finite timeout applies. */
  timer: AbortSignal | undefined;
  /** Caller-supplied signals (client-wide and per-call). */
  callerSignals: AbortSignal[];
}

function createDeadline(
  timeoutMs: number,
  clientSignal: AbortSignal | undefined,
  callSignal: AbortSignal | undefined,
): Deadline {
  const callerSignals = [clientSignal, callSignal].filter((s): s is AbortSignal => s !== undefined);
  const timer = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const all = timer ? [timer, ...callerSignals] : callerSignals;
  const signal = all.length === 0 ? undefined : all.length === 1 ? all[0] : AbortSignal.any(all);
  return { signal, timeoutMs, timer, callerSignals };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

/**
 * Map whatever `fetch` rejected with onto a `RekeyError`. Three codes, because
 * three different things go wrong and they want different responses:
 * `REQUEST_ABORTED` (you asked), `REQUEST_TIMEOUT` (retry / raise the limit),
 * `NETWORK_ERROR` (check the URL, DNS, TLS).
 */
function transportError(
  cause: unknown,
  deadline: Deadline,
  method: string,
  path: string,
): RekeyError {
  const where = `${method} ${path}`;

  if (deadline.callerSignals.some((s) => s.aborted)) {
    return new RekeyError({
      code: 'REQUEST_ABORTED',
      message: `${where} was aborted by the caller's AbortSignal.`,
      fix: 'This is your own cancellation — swallow it, or check the signal you passed to `signal` / `Rekey.with({ signal })`.',
      cause,
    });
  }

  if (deadline.timer?.aborted || (isAbortError(cause) && deadline.timer !== undefined)) {
    return new RekeyError({
      code: 'REQUEST_TIMEOUT',
      message: `${where} exceeded the ${deadline.timeoutMs}ms request deadline.`,
      fix: 'Retry, or raise `timeoutMs` on the client / this call if the endpoint is legitimately slow. If it never responds, check `apiUrl` points at a reachable Rekey deployment.',
      cause,
    });
  }

  return new RekeyError({
    code: 'NETWORK_ERROR',
    message: `${where} failed before the server answered: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    fix: 'Check `apiUrl`, DNS, and that the Rekey deployment is reachable from this host. The underlying error is on `error.cause`.',
    cause,
  });
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
    const app = await this.client.send<ApplicationDto>('GET', '/api/v1/me/');
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
    return this.client.send('GET', '/api/v1/me/');
  }
}

class AuthClient {
  constructor(private readonly client: Rekey) {}

  /**
   * Create a new end-user in the calling Application via email + password.
   * Returns the user plus an `accessToken` for subsequent per-user calls
   * (e.g. `getCurrentUser(accessToken)`) and a `refreshToken` to renew it.
   *
   * Unless the Application turns `authConfig.sendVerificationEmailOnSignUp`
   * off, Rekey also emails the verification link — best-effort, so it never
   * fails the sign-up, and `sendVerificationEmail` re-sends on demand.
   *
   * @example
   * ```ts
   * const { endUser, accessToken, refreshToken } = await rekey.auth.signUp({
   *   email: 'alice@example.com',
   *   password: 'correct-horse-battery-staple',
   * });
   * // store both in your session — the access token expires in 15 minutes
   * ```
   *
   * @throws {RekeyError} `EMAIL_ALREADY_EXISTS` (409) if the email is taken in this Application.
   * @throws {RekeyError} `PASSWORD_TOO_SHORT` (400) if shorter than the Application's `passwordMinLength`.
   * @throws {RekeyError} `AUTH_METHOD_DISABLED` (400) if the Application doesn't have `"password"` enabled.
   */
  signUp(input: SignUpRequest): Promise<AuthResultDto> {
    return this.client.send('POST', '/api/v1/auth/sign-up', input);
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
   * @throws {RekeyError} `EMAIL_NOT_VERIFIED` (403) when the Application sets
   *   `authConfig.requireEmailVerification` and the user hasn't confirmed their
   *   address. The password was correct — prompt for the emailed link (or call
   *   `sendVerificationEmail`), not for the password again.
   */
  signIn(input: SignInRequest): Promise<SignInOutcomeDto> {
    return this.client.send('POST', '/api/v1/auth/sign-in', input);
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
    return this.client.send('POST', '/api/v1/auth/mfa-verify', input);
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
    return this.client.send('POST', '/api/v1/auth/magic-link/request', input);
  }

  /**
   * Consume a magic-link token. Returns `SignInOutcome` — branch on
   * `mfaRequired` before reading `accessToken`. For MFA-enrolled users
   * the response carries `mfaChallengeToken` and you must complete via
   * `mfaVerify(...)`.
   */
  verifyMagicLink(input: { token: string }): Promise<SignInOutcomeDto> {
    return this.client.send('POST', '/api/v1/auth/magic-link/verify', input);
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
    return this.client.send('POST', '/api/v1/auth/passkey/authenticate/start', input ?? {});
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
    return this.client.send('POST', '/api/v1/auth/passkey/authenticate/complete', input);
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
    return this.client.send('POST', '/api/v1/auth/passkey/register/start', undefined, {
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
    return this.client.send('POST', '/api/v1/auth/passkey/register/complete', input, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * List the user's registered passkeys, newest first.
   *
   * Returns `{items, page}` — `page.total` is the number of passkeys the user
   * has, independent of the window served.
   */
  listPasskeys(
    accessToken: string,
    page?: ListPage,
  ): Promise<
    Paged<{
      id: string;
      credentialId: string;
      deviceName: string | null;
      lastUsedAt: string | null;
      createdAt: string;
    }>
  > {
    return this.client.send('GET', `/api/v1/auth/passkeys${listQuery(page)}`, undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Remove a passkey. Returns `{deleted: false}` if the row doesn't belong to this user. */
  deletePasskey(accessToken: string, credentialRowId: string): Promise<{ deleted: boolean }> {
    return this.client.send(
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
    return this.client.send('GET', '/api/v1/users/me/', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Update the end-user behind a presented access token — their OWN record,
   * and only ever their own: the token identifies the subject, so there is no
   * user id to pass and no way to aim this at anyone else.
   *
   * `metadata` is **shallow-merged** over what is stored, not replaced. A key
   * you leave out survives; a key you send replaces that top-level key
   * wholesale (nested objects are not deep-merged); a key sent as `null` is
   * deleted; `metadata: null` clears the whole object. So the read-edit-write
   * cycle below cannot clobber a key some other device wrote in between.
   *
   * Only `metadata` is writable here. Email, role and password are not
   * self-service and are refused rather than ignored.
   *
   * @example
   * ```ts
   * const user = await rekey.auth.updateCurrentUser(accessToken, {
   *   metadata: { displayName: 'Alice', theme: 'dark', oldFlag: null },
   * });
   * // oldFlag is gone; every other stored key is untouched
   * ```
   *
   * @throws {RekeyError} `END_USER_UPDATE_INVALID` (400) if the body names a field
   *   other than `metadata`.
   * @throws {RekeyError} `METADATA_TOO_LARGE` (400) if the merged metadata exceeds 16KB.
   * @throws {RekeyError} `USER_TOKEN_INVALID` (401) if expired/forged/wrong-secret.
   */
  updateCurrentUser(
    accessToken: string,
    input: { metadata?: Record<string, unknown> | null },
  ): Promise<EndUserDto & { activeOrganizationId: string | null }> {
    return this.client.send('PATCH', '/api/v1/users/me/', input, {
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
    return this.client.send('POST', '/api/v1/auth/refresh', { refreshToken });
  }

  /**
   * Revoke a refresh token. Idempotent — no-op for unknown tokens. The
   * access token paired with this refresh remains valid until its short
   * (15 min) expiry; for true "log out everywhere" semantics, also clear
   * the access token from your client.
   */
  signOut(refreshToken: string): Promise<{ signedOut: true }> {
    return this.client.send('POST', '/api/v1/auth/sign-out', { refreshToken });
  }

  /**
   * Request a password reset for an email. Always succeeds — never tells you
   * whether the email exists.
   *
   * **Branch on the result.** When the Application has an email transport
   * (BYO Resend/SMTP, or a deployment-wide `RESEND_DEFAULT_API_KEY`) Rekey sends
   * the mail itself and `resetToken` is null. With no transport it falls back to
   * the original contract and hands the raw token to you — a secret-key caller
   * only — so you can deliver it with your own provider.
   *
   * @example
   * ```ts
   * const { emailSent, resetToken } = await rekey.auth.requestPasswordReset({ email });
   * // Rekey sent it; nothing to do. Otherwise deliver the token yourself:
   * if (!emailSent && resetToken) {
   *   await sendgrid.send({ to: email, subject: 'Reset', text: `link: ${url(resetToken)}` });
   * }
   * ```
   */
  requestPasswordReset(input: ForgotPasswordRequest): Promise<ForgotPasswordResultDto> {
    return this.client.send('POST', '/api/v1/auth/forgot-password', input);
  }

  /**
   * Consume a reset token + set a new password. Single-use. On success,
   * every refresh token for the user is revoked.
   *
   * @throws {RekeyError} `PASSWORD_RESET_TOKEN_INVALID` / `_USED` / `_EXPIRED` / `_WRONG_APPLICATION`
   * @throws {RekeyError} `PASSWORD_TOO_SHORT` if below the Application's `passwordMinLength`
   */
  resetPassword(input: ResetPasswordRequest): Promise<{ ok: true }> {
    return this.client.send('POST', '/api/v1/auth/reset-password', input);
  }

  /**
   * Authenticated password change. Pass the user's *current* access token.
   * On success, every refresh token for the user is revoked — other devices
   * are signed out.
   */
  changePassword(accessToken: string, input: ChangePasswordRequest): Promise<{ ok: true }> {
    return this.client.send('POST', '/api/v1/auth/change-password', input, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Revoke every refresh token for the calling user. "Sign out of all
   * devices." The caller's access token remains valid until 15-min expiry
   * — clear it client-side for full logout.
   */
  signOutEverywhere(accessToken: string): Promise<{ revokedCount: number }> {
    return this.client.send(
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
    return this.client.send('POST', '/api/v1/auth/send-verification', input ?? {}, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Re-send a verification link to an address, with **no session** — the
   * sessionless sibling of `sendVerificationEmail`.
   *
   * This is the route for a user locked out by
   * `authConfig.requireEmailVerification`: that setting refuses the very
   * session `sendVerificationEmail` needs, so a user whose first mail never
   * arrived cannot ask for another. Takes the address instead of a token.
   *
   * **Branch on the result**, exactly as with `requestPasswordReset` — the
   * contract is the same one. It never throws for an unknown address and never
   * discloses whether the address exists, is already verified, or was mailed:
   * a publishable-key caller gets one constant body whatever happened. A
   * secret-key caller — this SDK — gets the real outcome, and the raw
   * `verificationToken` when the Application has no email transport configured,
   * so you can deliver it with your own provider.
   *
   * Pass `verifyUrl` containing `{token}` to template the link target. Unlike
   * `sendVerificationEmail`, nothing is sent and no token is minted when no
   * link can be built at all — pass `verifyUrl`, or set the Application URL
   * (Panel → Application → Auth). Mailing a locked-out user a verification
   * message with no button in it helps nobody.
   *
   * @example
   * ```ts
   * const { emailSent, verificationToken } = await rekey.auth.resendVerificationEmail({ email });
   * // Rekey sent it; nothing to do. Otherwise deliver the token yourself:
   * if (!emailSent && verificationToken) {
   *   await mailer.send({ to: email, text: `Verify: ${url(verificationToken)}` });
   * }
   * // Always render the same neutral "if that address needs verifying, we sent a link".
   * ```
   */
  resendVerificationEmail(input: {
    email: string;
    verifyUrl?: string;
  }): Promise<{ emailSent: boolean; verificationToken: string | null }> {
    return this.client.send('POST', '/api/v1/auth/resend-verification', input);
  }

  /**
   * Consume an email-verification token. Single-use, 24-hour lifetime.
   * Marks `emailVerified: true` on the user record. Cross-Application
   * tokens are refused with `EMAIL_VERIFICATION_TOKEN_WRONG_APPLICATION`.
   */
  verifyEmail(input: { token: string }): Promise<{ verified: true; endUser: EndUserDto }> {
    return this.client.send('POST', '/api/v1/auth/verify-email', input);
  }

  // ---------- Active sessions ----------

  /**
   * List the current user's active sessions (live refresh tokens), newest
   * first. Each carries the User-Agent + IP captured at issue time and an
   * `id` you can pass to `revokeSession(...)`.
   */
  listSessions(
    accessToken: string,
    page?: ListPage,
  ): Promise<
    Paged<{
      id: string;
      createdAt: string;
      expiresAt: string;
      userAgent: string | null;
      ip: string | null;
    }>
  > {
    return this.client.send('GET', `/api/v1/auth/sessions${listQuery(page)}`, undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Revoke one session by id. Idempotent — `{ revoked: false }` if it isn't this user's. */
  revokeSession(accessToken: string, sessionId: string): Promise<{ revoked: boolean }> {
    return this.client.send(
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
    return this.client.send('GET', '/api/v1/auth/mfa/status', undefined, {
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
    return this.client.send('POST', '/api/v1/auth/mfa/setup', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Confirm enrollment by submitting the current 6-digit TOTP code. */
  confirmMfaSetup(accessToken: string, code: string): Promise<{ ok: true }> {
    return this.client.send('POST', '/api/v1/auth/mfa/setup-confirm', { code }, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Verify a TOTP or backup code as a step-up check (does NOT issue a session).
   * Backup codes are single-use — consumed on success. Returns `{ ok }`.
   */
  mfaChallenge(accessToken: string, code: string): Promise<{ ok: boolean }> {
    return this.client.send('POST', '/api/v1/auth/mfa/challenge', { code }, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Disable MFA for the current user. */
  disableMfa(accessToken: string): Promise<{ disabled: true }> {
    return this.client.send('POST', '/api/v1/auth/mfa/disable', undefined, {
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
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send('GET', '/api/v1/auth/oauth/identities', undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Begin linking a provider to the *currently authenticated* user. */
  startOAuthLink(
    accessToken: string,
    provider: string,
    state: string,
  ): Promise<{ authorizationUrl: string }> {
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send(
      'DELETE',
      `/api/v1/auth/oauth/${encodeURIComponent(provider)}`,
      undefined,
      { 'X-Rekey-User-Token': accessToken },
    );
  }
}

/**
 * Optional offset pagination for list endpoints. The API caps these lists
 * (default 50, max 100); pass `offset` to page beyond the first window.
 *
 * Re-exported from `@rekey.dev/shared-types` so the SDK, the API and the panel
 * all name one shape. Every list method returns {@link Paged}, whose `page`
 * tells you whether there is another window — you no longer have to infer it
 * by asking for one row more than you need.
 */
export type { ListPage, PageMeta, Paged } from '@rekey.dev/shared-types';

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
    return this.client.send('POST', '/api/v1/users/me/organizations/', input, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * List organizations the calling user belongs to, with their role.
   *
   * Paginated (default 50, max 100). Read `page.hasMore` / `page.total` from
   * the result rather than guessing from `items.length`.
   */
  listMine(accessToken: string, page?: ListPage): Promise<Paged<OrganizationWithRoleDto>> {
    return this.client.send('GET', `/api/v1/users/me/organizations/${listQuery(page)}`, undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /** Fetch one organization the caller belongs to. */
  get(accessToken: string, organizationId: string): Promise<OrganizationWithRoleDto> {
    return this.client.send(
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
    return this.client.send(
      'PATCH',
      `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}`,
      input,
      { 'X-Rekey-User-Token': accessToken },
    );
  }

  /**
   * List members of an organization the caller belongs to.
   *
   * Paginated (default 50, max 100). `page.total` is the org's member count,
   * so you do not need a second call to render "3 of 40".
   */
  listMembers(
    accessToken: string,
    organizationId: string,
    page?: ListPage,
  ): Promise<Paged<OrganizationMemberDto>> {
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send(
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
    return this.client.send('POST', '/api/v1/licenses/verify', input);
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
    return this.client.send('POST', '/api/v1/usage/record', input);
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
    return this.client.send('GET', `/api/v1/usage/aggregate?${params.toString()}`);
  }
}

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

/**
 * Prepaid credits — the "lead pack" / pay-as-you-go drawdown model. The
 * customer's backend grants credits (by selling a CREDIT-kind plan, which
 * grants automatically on payment) and draws them down per unit consumed.
 *
 * All calls are server-to-server (secret key) and scoped to a `CreditSubject` —
 * an end-user's personal balance, or an organization's shared pool.
 */
class CreditsClient {
  constructor(private readonly client: Rekey) {}

  /** Current spendable balance for a subject (end-user or org); 0 if none. */
  getBalance(subject: CreditSubject): Promise<CreditBalanceDto> {
    return this.client.send('GET', `/api/v1/credits/balance?${creditSubjectQuery(subject)}`);
  }

  /**
   * Deduct credits from a subject (end-user or org pool). Throws `RekeyError`
   * `code: "CREDITS_INSUFFICIENT"` (HTTP 402) when the balance is too low.
   *
   * Pass `idempotencyKey` (e.g. the lead id) so a retried call never
   * double-charges — a repeat returns the original result with `applied: false`.
   */
  consume(input: ConsumeCreditsRequest & CreditSubject): Promise<ConsumeCreditsResultDto> {
    return this.client.send('POST', '/api/v1/credits/consume', input);
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
  ): Promise<Paged<CreditLedgerEntryDto>> {
    const params = new URLSearchParams(creditSubjectQuery(subject));
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    return this.client.send('GET', `/api/v1/credits/ledger?${params.toString()}`);
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
 * Load Node's crypto lazily, from an ESM module.
 *
 * This is deliberately `createRequire` and not a bare `require`. The package is
 * `"type": "module"` with ESM-only `exports`, so in the built `dist` a bare
 * `require` is simply not defined — `verifyWebhookSignature` and the RS256 path
 * of `verifyAccessToken` threw `ReferenceError: require is not defined` for
 * every consumer who installed from npm, in every published version.
 *
 * It went unnoticed because `node -e` defines `globalThis.require`, so the
 * failure does not reproduce in a one-liner — only in a real `.mjs`, `.cjs`, or
 * `"type": "module"` package, which is to say only in real use. The tests
 * exercise the TypeScript source rather than the built ESM artifact, so they
 * never saw it either.
 *
 * The laziness is still worth keeping: signature verification is the one place
 * this SDK needs crypto, and importing it at module scope would break the edge
 * runtimes that can otherwise use the rest of the client.
 */
function nodeCrypto(): typeof import('node:crypto') {
  // `process.getBuiltinModule` (Node 22.3+, and this package's floor is 22)
  // resolves a builtin synchronously with NO static import — which is the
  // whole point. The previous fix used `createRequire`, correct for CJS
  // interop but imported from 'node:module' at module scope, so merely
  // IMPORTING the package failed on edge runtimes with
  // `Failed to load external module node:module`. That defeated the laziness
  // this function's own comment says it exists to preserve: before, edge
  // consumers could import the client and use every fetch-based method, and
  // only calling signature verification would fail.
  const get = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    ?.getBuiltinModule;
  const mod = typeof get === 'function' ? get('node:crypto') : undefined;
  if (!mod) {
    throw new Error(
      'Signature verification needs Node crypto, which is unavailable in this runtime. ' +
        'Run verifyWebhookSignature / verifyAccessToken (RS256) on a Node server, not an edge runtime.',
    );
  }
  return mod as typeof import('node:crypto');
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
 *     secret: process.env.REKEY_WEBHOOK_SECRET!,
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

  const { createHmac, timingSafeEqual } = nodeCrypto();
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
   * The Application this token must belong to. **Required.**
   *
   * This helper verifies RS256 tokens against the deployment's JWKS, and the
   * RS256 keypair is deployment-wide — `SigningKey` has no `applicationId`
   * column, and `eu_access` tokens carry no `iss`/`aud`. So a token minted for
   * ANY Application on the same deployment is cryptographically valid here.
   * Without this, a multi-app self-host accepts another Application's end-user
   * as its own.
   *
   * (The HS256 default path is not affected: that key is derived per
   * Application as `HMAC-SHA256(JWT_SECRET, applicationId:tokenGeneration)`, so
   * a foreign token fails the signature. This is the RS256 opt-in only — which
   * is exactly the path this function exists for.)
   *
   * Required rather than optional-with-a-warning: a security check nobody is
   * forced to make is one most callers will not make, and the docblock used to
   * tell them to compare `claims.applicationId` afterwards — which made the
   * shortest correct path the insecure one. 2.0.0 is not out yet, so this
   * breaks rc callers rather than a stable contract.
   */
  applicationId: string;
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
  /**
   * Deadline for the JWKS fetch, in ms. Default {@link DEFAULT_TIMEOUT_MS}
   * (10 000); `0` disables. This one matters more than most: token
   * verification usually sits in a hot request path, and an unreachable JWKS
   * host would otherwise stall it for undici's five-minute header timeout.
   * Pass a pre-fetched `jwks` to skip the network entirely.
   */
  timeoutMs?: number | undefined;
  /** Abort signal for the JWKS fetch. Composed with the deadline. */
  signal?: AbortSignal | undefined;
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
  const deadline = createDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, undefined, options.signal);
  let res: Response;
  try {
    res = await fetchImpl(url, deadline.signal ? { signal: deadline.signal } : {});
  } catch (cause) {
    throw transportError(cause, deadline, 'GET', url);
  }
  if (!res.ok) {
    throw new RekeyError({
      code: 'JWKS_FETCH_FAILED',
      message: `Fetching the JWKS from ${url} failed with status ${res.status}.`,
      fix: 'Check the URL points at your Rekey deployment’s /.well-known/jwks.json.',
      statusCode: res.status,
    });
  }
  let jwks: JwksDto;
  try {
    jwks = (await res.json()) as JwksDto;
  } catch (cause) {
    if (isAbortError(cause)) throw transportError(cause, deadline, 'GET', url);
    throw new RekeyError({
      code: 'JWKS_FETCH_FAILED',
      message: `The JWKS endpoint at ${url} did not return JSON.`,
      fix: 'Check the URL points at /.well-known/jwks.json, not an HTML error page.',
      cause,
    });
  }
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
 *   applicationId: MY_APP_ID,
 *   jwksUrl: 'https://rekey.example.com/.well-known/jwks.json',
 * });
 * req.userId = claims.sub;
 * ```
 *
 * `applicationId` is required and checked inside this function. The RS256
 * keypair is deployment-wide and `eu_access` tokens carry no `iss`/`aud`, so
 * without it a token minted for any other Application on the same deployment
 * verifies here with a perfectly valid signature. This example used to show
 * the comparison being done by the caller afterwards, which is precisely why
 * it moved inside: the shortest correct path should not be the one nobody
 * takes.
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
  const { createPublicKey, verify } = nodeCrypto();
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

  // Bind the token to ONE Application. The signing key is deployment-wide and
  // `eu_access` carries no `iss`/`aud`, so a token minted for a different
  // Application on the same deployment is cryptographically valid here — on a
  // multi-app self-host that means accepting someone else's end-user as your
  // own. The API does compare this server-side; the SDK left it to the caller
  // and documented it as a follow-up step, which made the shortest correct
  // path the one nobody takes.
  if (payload.applicationId !== options.applicationId) {
    throw invalid('Token was issued for a different Application.');
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
  getPlans(page?: ListPage): Promise<Paged<PlanDto>> {
    return this.client.send('GET', `/api/v1/billing/plans${listQuery(page)}`);
  }

  /**
   * Fetch the current end-user's active subscription, or `null` if they
   * have none. Returns the most recent ACTIVE / PENDING / PAST_DUE row.
   *
   * Pass the user's access token (the SDK puts it in `X-Rekey-User-Token`).
   *
   * `opts.includeEnded` falls back to the most recent CANCELED/EXPIRED
   * subscription **only when the answer would otherwise be null** — for a
   * billing page that has to tell a former subscriber what they were on and
   * when it ended, rather than showing them the same blank state as somebody
   * who never subscribed. It can never replace a live subscription, so it is
   * safe to add to an existing call; it is off by default all the same,
   * because an entitlement check wants the strict question.
   *
   * `opts.organizationId` reads an organization's subscription instead of the
   * user's own on an org-billed app. The caller must be a member.
   */
  getSubscription(
    accessToken: string,
    opts?: { organizationId?: string; includeEnded?: boolean },
  ): Promise<SubscriptionDto | null> {
    const qs = new URLSearchParams();
    if (opts?.organizationId) qs.set('organizationId', opts.organizationId);
    if (opts?.includeEnded) qs.set('includeEnded', 'true');
    const query = qs.toString();
    const suffix = query ? `?${query}` : '';
    return this.client.send('GET', `/api/v1/billing/subscription${suffix}`, undefined, {
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
    return this.client.send('POST', '/api/v1/billing/checkout', input, {
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
    return this.client.send('POST', '/api/v1/billing/coupons/validate', input, {
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
    return this.client.send('GET', '/api/v1/billing/providers', undefined, headers);
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
    return this.client.send('GET', `/api/v1/billing/entitlements${qs}`, undefined, {
      'X-Rekey-User-Token': accessToken,
    });
  }

  /**
   * Cancel the calling end-user's current subscription.
   *
   * Defaults to cancelling **at period end** — the user keeps what they paid
   * for until the period they already bought runs out. A provider-backed
   * subscription therefore stays ACTIVE with `cancelAt` set, and the provider
   * webhook is what eventually terminates it; read `cancelAt` on the returned
   * row rather than expecting `status` to have flipped. Pass
   * `{ atPeriodEnd: false }` to end it immediately, forfeiting the remainder.
   *
   * PENDING checkouts (and anything with no provider-side record) are
   * cancelled locally straight away regardless of the flag — there is nothing
   * at the provider to schedule against.
   *
   * Pass `organizationId` when the subscription belongs to a team; the caller
   * must be its OWNER or ADMIN.
   *
   * @example
   * ```ts
   * const sub = await rekey.billing.cancelSubscription(userAccessToken);
   * // Tell them what they actually get: access until the date they paid through.
   * console.log(`Access until ${sub.cancelAt ?? sub.currentPeriodEnd}`);
   * ```
   */
  cancelSubscription(
    accessToken: string,
    input?: { atPeriodEnd?: boolean; organizationId?: string },
  ): Promise<SubscriptionDto> {
    return this.client.send(
      'POST',
      '/api/v1/billing/subscription/cancel',
      {
        // Omitted rather than sent as undefined so the API applies its own
        // default (at period end) instead of parsing a null-ish field.
        ...(input?.atPeriodEnd !== undefined && { atPeriodEnd: input.atPeriodEnd }),
        ...(input?.organizationId && { organizationId: input.organizationId }),
      },
      { 'X-Rekey-User-Token': accessToken },
    );
  }
}
