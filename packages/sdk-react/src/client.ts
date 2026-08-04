/**
 * Browser-side Rekey client.
 *
 * Two credentials, never the secret key:
 *   1. **Publishable key** (`rp_pub_…`). A browser-safe Application credential
 *      passed once at construction. It authorizes the **public-bootstrap**
 *      calls a signed-out user makes — sign-up, sign-in, magic-link, passkey
 *      authenticate, license verify, plan + provider listing — so a frontend/mobile/
 *      desktop app needs NO backend to log users in. It only identifies the
 *      app; it grants nothing on its own (sign-in still needs the password,
 *      license verify still needs the license key).
 *   2. **User JWT** (per call). Once signed in, per-user reads use the short
 *      lived access token via the `X-Rekey-User-Token` header.
 *
 * The secret key (`rp_live_*` / `rp_test_*`) NEVER belongs in the browser. Note
 * what that does and does not rule out: the self-service tier — checkout,
 * cancel own subscription, own entitlements, own payments, own orgs — runs on
 * the publishable key PLUS the user's own token and acts only on that user's
 * resources, which is what makes a backendless portal possible. What stays
 * secret-key-only is the operator/tenant surface and any read across users; use
 * `@rekey.dev/node` from your server for those.
 *
 * `apiUrl` is required. Bring-your-own fetch is supported for SSR/SSE shims
 * and tests.
 */

import type {
  EndUserDto,
  RekeyErrorShape,
  SignUpRequest,
  SignInRequest,
  MfaVerifyRequest,
  AuthResultDto,
  SignInOutcomeDto,
  PlanDto,
  LicenseVerifyResultDto,
  SubscriptionDto,
  CreateCheckoutRequest,
  CheckoutResultDto,
  OrganizationWithRoleDto,
  ProvidersListDto,
  ListPage,
  Paged,
} from '@rekey.dev/shared-types';
// NOTE the subpath. `RekeyError` is the ONLY value this package imports from
// shared-types — everything above is a type and erases. Importing it from the
// barrel made every bundle that touches this module keep zod plus ~60
// module-scope `z.object(...)` calls alive: `useUser` alone measured 74,556
// bytes minified. `@rekey.dev/shared-types/error` has zero imports, and the
// same import measured 902 bytes. Same class, same `instanceof`. Keep it.
import { RekeyError } from '@rekey.dev/shared-types/error';

/** Resolved entitlements for the signed-in user (mirrors @rekey.dev/node). */
export interface EntitlementsDto {
  features: Record<string, boolean | number | string>;
  entitlements: Array<{
    kind: 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';
    key: string;
    valueType: 'BOOL' | 'INT' | 'STRING' | null;
    value: string | null;
    quantity: number | null;
    licenseKind: 'PERPETUAL' | 'TIMED' | 'SEATS' | null;
    rollover: boolean;
  }>;
  creditBalance: number;
}

/** A row from `GET /billing/payments` — the signed-in user's own payment. */
export interface PortalPaymentDto {
  id: string;
  amount: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  description: string | null;
  createdAt: string;
  subscriptionId: string | null;
  planSlug: string | null;
  receiptUrl: string | null;
}

export interface RekeyBrowserConfig {
  apiUrl: string;
  /**
   * Publishable key (`rp_pub_…`) for this Application. Required to use the
   * bootstrap auth/license/plan methods; omit it only if you exclusively read
   * the current user via an already-minted access token.
   */
  publishableKey?: string;
  fetch?: typeof fetch;
}

// RekeyError is the shared class (imported above) — re-exported so the public
// name is preserved and `instanceof` matches @rekey.dev/node.
export { RekeyError };

/**
 * Build the `?limit=&offset=` query for a list method.
 *
 * Every list endpoint in the API takes the same two params and answers with
 * `{items, page}`; this keeps the SDK from spelling that out five times.
 */
function listQuery(page?: ListPage): string {
  if (!page) return '';
  const p = new URLSearchParams();
  if (page.limit !== undefined) p.set('limit', String(page.limit));
  if (page.offset !== undefined) p.set('offset', String(page.offset));
  const s = p.toString();
  return s ? `?${s}` : '';
}

interface RawResp<T> {
  data: T;
  status: number;
}

export class RekeyBrowserClient {
  private readonly apiUrl: string;
  private readonly publishableKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RekeyBrowserConfig) {
    if (!config.apiUrl) {
      throw new RekeyError({
        code: 'CONFIG_MISSING_API_URL',
        message: '@rekey.dev/react: apiUrl is required.',
        fix: 'Pass apiUrl when constructing RekeyBrowserClient or via <RekeyProvider apiUrl=...>',
      });
    }
    if (config.publishableKey && !config.publishableKey.startsWith('rp_pub_')) {
      throw new RekeyError({
        code: 'CONFIG_INVALID_PUBLISHABLE_KEY',
        message: '@rekey.dev/react: publishableKey must start with `rp_pub_`.',
        fix: 'Copy the publishable key from Panel → Application → API keys. Never put a secret key (rp_live_/rp_test_) in the browser.',
      });
    }
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.publishableKey = config.publishableKey;
    this.fetchImpl = config.fetch ?? fetch.bind(globalThis);
  }

  /**
   * Fetch the current end-user given an access token. Returns null on
   * USER_TOKEN_INVALID so callers can render signed-out state without
   * try/catch noise.
   *
   * Hits `GET /api/v1/auth/me` — a user-token-only endpoint: it resolves the
   * end-user from the `X-Rekey-User-Token` JWT alone, with NO Application
   * secret key (the browser must never hold one). The JWT is API-signed and
   * carries the user + application ids, so it is a sufficient credential.
   *
   * Override `meEndpoint` only for deployments that expose the resolution
   * under a different path.
   */
  async getCurrentUser(accessToken: string, meEndpoint = '/api/v1/auth/me'): Promise<EndUserDto | null> {
    try {
      const res = await this.raw<EndUserDto>('GET', meEndpoint, undefined, { accessToken });
      return res.data;
    } catch (err) {
      if (err instanceof RekeyError && err.code === 'USER_TOKEN_INVALID') {
        return null;
      }
      throw err;
    }
  }

  // ---------- Public-bootstrap methods (publishable-key authorized) ----------

  /** Create a new end-user (email + password). Returns the user + session tokens. */
  signUp(input: SignUpRequest): Promise<AuthResultDto> {
    return this.bootstrap<AuthResultDto>('POST', '/api/v1/auth/sign-up', input);
  }

  /**
   * Authenticate (email + password). Returns a `SignInOutcome` — branch on
   * `mfaRequired` before reading `accessToken`; MFA-enrolled users get an
   * `mfaChallengeToken`, complete via `mfaVerify(...)`.
   */
  signIn(input: SignInRequest): Promise<SignInOutcomeDto> {
    return this.bootstrap<SignInOutcomeDto>('POST', '/api/v1/auth/sign-in', input);
  }

  /** Exchange an MFA challenge token + code for a real session. */
  mfaVerify(input: MfaVerifyRequest): Promise<AuthResultDto> {
    return this.bootstrap<AuthResultDto>('POST', '/api/v1/auth/mfa-verify', input);
  }

  /** Request a magic-link sign-in email. Enumeration-safe. */
  requestMagicLink(input: { email: string; signInUrl?: string }): Promise<{
    delivered: boolean;
    emailSent: boolean;
    magicLinkToken: string | null;
  }> {
    return this.bootstrap('POST', '/api/v1/auth/magic-link/request', input);
  }

  /** Consume a magic-link token. Returns a `SignInOutcome` (branch on `mfaRequired`). */
  verifyMagicLink(input: { token: string }): Promise<SignInOutcomeDto> {
    return this.bootstrap<SignInOutcomeDto>('POST', '/api/v1/auth/magic-link/verify', input);
  }

  /** Exchange a refresh token for a fresh access/refresh pair. */
  refresh(refreshToken: string): Promise<AuthResultDto> {
    return this.bootstrap<AuthResultDto>('POST', '/api/v1/auth/refresh', { refreshToken });
  }

  /** Revoke a refresh token (sign out). Idempotent. */
  signOut(refreshToken: string): Promise<{ signedOut: true }> {
    return this.bootstrap<{ signedOut: true }>('POST', '/api/v1/auth/sign-out', { refreshToken });
  }

  /** Begin a passkey authentication ceremony — forward `options` to `navigator.credentials.get`. */
  startPasskeyAuthentication(input?: { email?: string }): Promise<{
    options: unknown;
    expectedChallenge: string;
  }> {
    return this.bootstrap('POST', '/api/v1/auth/passkey/authenticate/start', input ?? {});
  }

  /** Complete a passkey authentication. Returns a `SignInOutcome`. */
  verifyPasskeyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
  }): Promise<SignInOutcomeDto> {
    return this.bootstrap<SignInOutcomeDto>('POST', '/api/v1/auth/passkey/authenticate/complete', input);
  }

  /**
   * List the Application's active plans (public catalogue — for pricing pages).
   *
   * Returns the `{items, page}` envelope, not a bare array: a pricing page that
   * quietly renders the first 50 of 80 plans is a pricing page that is wrong,
   * and only `page.total` can tell you that happened. Pass `page.offset` for
   * the next window.
   */
  getPlans(page?: ListPage): Promise<Paged<PlanDto>> {
    return this.bootstrap<Paged<PlanDto>>('GET', `/api/v1/billing/plans${listQuery(page)}`, undefined);
  }

  /**
   * The billing providers enabled for this Application, in the order the geo
   * router prefers them (the first is the default pick). Powers a "Pay with…"
   * picker at checkout — feed the result straight into `<ProviderPicker>`.
   *
   * Public, like {@link getPlans}: needs only the publishable key, no user
   * token. Pass `country` (ISO 3166-1 alpha-2) to bias the ordering when the
   * request's geo can't be inferred from edge headers (e.g. a server-side call).
   */
  listBillingProviders(opts?: { country?: string }): Promise<ProvidersListDto> {
    const headers = opts?.country ? { 'x-country': opts.country.toUpperCase() } : undefined;
    return this.bootstrap<ProvidersListDto>('GET', '/api/v1/billing/providers', undefined, headers);
  }

  /**
   * Verify a license key for this machine. The license `key` is the entitlement
   * bearer; the publishable key only identifies the Application. `ok=false` is a
   * normal result for an invalid/expired license, not an exception.
   */
  verifyLicense(input: {
    key: string;
    machineFingerprint: string;
    label?: string;
  }): Promise<LicenseVerifyResultDto> {
    return this.bootstrap<LicenseVerifyResultDto>('POST', '/api/v1/licenses/verify', input);
  }

  // ---------- Self-service billing (publishable key + the user's own token) ----------
  // These authorize on the user's token (X-Rekey-User-Token) and act ONLY on
  // that user's own resources; the publishable key identifies the app. Powers a
  // backendless customer portal.

  /**
   * The current subscription — the user's own by default, or an organization's
   * when `opts.organizationId` is passed (org-billed apps; caller must be a
   * member). Returns null when there's no active/pending/past-due subscription.
   *
   * `opts.includeEnded` falls back to the most recent CANCELED/EXPIRED
   * subscription **only when the answer would otherwise be null** — so a
   * billing page can say what a former subscriber was on and when it ended
   * instead of rendering the never-subscribed empty state at them. It never
   * replaces a live subscription; leave it off for entitlement checks.
   */
  getSubscription(
    accessToken: string,
    opts?: { organizationId?: string; includeEnded?: boolean },
  ): Promise<SubscriptionDto | null> {
    const params = new URLSearchParams();
    if (opts?.organizationId) params.set('organizationId', opts.organizationId);
    if (opts?.includeEnded) params.set('includeEnded', 'true');
    const query = params.toString();
    const qs = query ? `?${query}` : '';
    return this.selfService<SubscriptionDto | null>('GET', `/api/v1/billing/subscription${qs}`, undefined, accessToken);
  }

  /** Organizations the signed-in user belongs to, each with their role. */
  listOrganizations(accessToken: string, page?: ListPage): Promise<Paged<OrganizationWithRoleDto>> {
    return this.selfService<Paged<OrganizationWithRoleDto>>(
      'GET',
      `/api/v1/users/me/organizations/${listQuery(page)}`,
      undefined,
      accessToken,
    );
  }

  /** The signed-in user's entitlements (features, limits, credit balance). */
  getEntitlements(accessToken: string, opts?: { organizationId?: string }): Promise<EntitlementsDto> {
    const qs = opts?.organizationId ? `?organizationId=${encodeURIComponent(opts.organizationId)}` : '';
    return this.selfService<EntitlementsDto>('GET', `/api/v1/billing/entitlements${qs}`, undefined, accessToken);
  }

  /**
   * The signed-in user's own payment history, newest first.
   *
   * `page.total` is the user's lifetime payment count, so a portal can render
   * "12 of 137" without a second request.
   */
  listPayments(accessToken: string, limit?: number, offset?: number): Promise<Paged<PortalPaymentDto>> {
    const qs = listQuery({
      ...(limit !== undefined && { limit }),
      ...(offset !== undefined && { offset }),
    });
    return this.selfService<Paged<PortalPaymentDto>>(
      'GET',
      `/api/v1/billing/payments${qs}`,
      undefined,
      accessToken,
    );
  }

  /**
   * Cancel the current subscription (default: at period end). Pass
   * `opts.organizationId` to cancel an org's subscription (caller must be
   * OWNER/ADMIN of that org).
   */
  cancelSubscription(
    accessToken: string,
    opts?: { atPeriodEnd?: boolean; organizationId?: string },
  ): Promise<SubscriptionDto> {
    return this.selfService<SubscriptionDto>(
      'POST',
      '/api/v1/billing/subscription/cancel',
      {
        ...(opts?.atPeriodEnd !== undefined && { atPeriodEnd: opts.atPeriodEnd }),
        ...(opts?.organizationId && { organizationId: opts.organizationId }),
      },
      accessToken,
    );
  }

  /** Start a hosted-checkout session for the signed-in user. Returns the redirect URL. */
  createCheckout(
    accessToken: string,
    input: CreateCheckoutRequest & { couponCode?: string },
  ): Promise<CheckoutResultDto> {
    return this.selfService<CheckoutResultDto>('POST', '/api/v1/billing/checkout', input, accessToken);
  }

  // ---------- internals ----------

  /** Self-service call — sends BOTH the publishable key (app) and the user token. */
  private selfService<T>(method: string, path: string, body: unknown, accessToken: string): Promise<T> {
    if (!this.publishableKey) {
      throw new RekeyError({
        code: 'CONFIG_MISSING_PUBLISHABLE_KEY',
        message: `@rekey.dev/react: ${path} needs a publishable key.`,
        fix: 'Pass publishableKey to RekeyBrowserClient / <RekeyProvider publishableKey="rp_pub_…">.',
      });
    }
    return this.raw<T>(method, path, body, { publishable: true, accessToken }).then((r) => r.data);
  }

  /** Bootstrap call — sends the publishable key as the Application credential. */
  private bootstrap<T>(
    method: string,
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    if (!this.publishableKey) {
      throw new RekeyError({
        code: 'CONFIG_MISSING_PUBLISHABLE_KEY',
        message: `@rekey.dev/react: ${path} needs a publishable key.`,
        fix: 'Pass publishableKey to RekeyBrowserClient / <RekeyProvider publishableKey="rp_pub_…">.',
      });
    }
    return this.raw<T>(method, path, body, { publishable: true, ...(headers && { headers }) }).then(
      (r) => r.data,
    );
  }

  private async raw<T>(
    method: string,
    path: string,
    body: unknown,
    opts: { accessToken?: string | null; publishable?: boolean; headers?: Record<string, string> } = {},
  ): Promise<RawResp<T>> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        ...(opts.publishable && this.publishableKey
          ? { Authorization: `Bearer ${this.publishableKey}` }
          : {}),
        ...(opts.accessToken ? { 'X-Rekey-User-Token': opts.accessToken } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: 'include',
    });
    const json = (await res.json().catch(() => ({}))) as
      | { success: true; data: T }
      | { success: false; error: RekeyErrorShape };
    if (!res.ok || ('success' in json && json.success === false)) {
      const err =
        'error' in json
          ? json.error
          : { code: 'UNKNOWN_ERROR', message: `HTTP ${res.status}` };
      throw new RekeyError({ ...err, statusCode: res.status });
    }
    return { data: (json as { success: true; data: T }).data, status: res.status };
  }
}

export type {
  EndUserDto,
  ProvidersListDto,
  BillingProviderInfoDto,
  BillingProviderCapabilities,
  BillingProvider,
  // The list envelope every `list*` / `getPlans` method resolves to, and the
  // `{limit, offset}` request shape they accept. Re-exported so a consumer can
  // name the page without also depending on @rekey.dev/shared-types.
  ListPage,
  PageMeta,
  Paged,
} from '@rekey.dev/shared-types';
