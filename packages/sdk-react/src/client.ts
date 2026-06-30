/**
 * Browser-side ReliPay client.
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
 *      lived access token via the `X-Relipay-User-Token` header.
 *
 * The secret key (`rp_live_*`) NEVER belongs in the browser — money and
 * account-management routes reject the publishable key and require it
 * server-side via `@relipay/node`.
 *
 * `apiUrl` is required. Bring-your-own fetch is supported for SSR/SSE shims
 * and tests.
 */

import type {
  EndUserDto,
  RelipayErrorShape,
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
} from '@relipay/shared-types';
import { RelipayError } from '@relipay/shared-types';

/** Resolved entitlements for the signed-in user (mirrors @relipay/node). */
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

export interface ReliPayBrowserConfig {
  apiUrl: string;
  /**
   * Publishable key (`rp_pub_…`) for this Application. Required to use the
   * bootstrap auth/license/plan methods; omit it only if you exclusively read
   * the current user via an already-minted access token.
   */
  publishableKey?: string;
  fetch?: typeof fetch;
}

// RelipayError is the shared class (imported above) — re-exported so the public
// name is preserved and `instanceof` matches @relipay/node.
export { RelipayError };

interface RawResp<T> {
  data: T;
  status: number;
}

export class RelipayBrowserClient {
  private readonly apiUrl: string;
  private readonly publishableKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ReliPayBrowserConfig) {
    if (!config.apiUrl) {
      throw new RelipayError({
        code: 'CONFIG_MISSING_API_URL',
        message: '@relipay/react: apiUrl is required.',
        fix: 'Pass apiUrl when constructing RelipayBrowserClient or via <RelipayProvider apiUrl=...>',
      });
    }
    if (config.publishableKey && !config.publishableKey.startsWith('rp_pub_')) {
      throw new RelipayError({
        code: 'CONFIG_INVALID_PUBLISHABLE_KEY',
        message: '@relipay/react: publishableKey must start with `rp_pub_`.',
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
   * end-user from the `X-Relipay-User-Token` JWT alone, with NO Application
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
      if (err instanceof RelipayError && err.code === 'USER_TOKEN_INVALID') {
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

  /** List the Application's active plans (public catalogue — for pricing pages). */
  getPlans(): Promise<PlanDto[]> {
    return this.bootstrap<PlanDto[]>('GET', '/api/v1/billing/plans', undefined);
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
  // These authorize on the user's token (X-Relipay-User-Token) and act ONLY on
  // that user's own resources; the publishable key identifies the app. Powers a
  // backendless customer portal.

  /**
   * The current subscription — the user's own by default, or an organization's
   * when `opts.organizationId` is passed (org-billed apps; caller must be a
   * member). Returns null when there's no active/pending/past-due subscription.
   */
  getSubscription(accessToken: string, opts?: { organizationId?: string }): Promise<SubscriptionDto | null> {
    const qs = opts?.organizationId ? `?organizationId=${encodeURIComponent(opts.organizationId)}` : '';
    return this.selfService<SubscriptionDto | null>('GET', `/api/v1/billing/subscription${qs}`, undefined, accessToken);
  }

  /** Organizations the signed-in user belongs to, each with their role. */
  listOrganizations(accessToken: string): Promise<OrganizationWithRoleDto[]> {
    return this.selfService<OrganizationWithRoleDto[]>('GET', '/api/v1/users/me/organizations/', undefined, accessToken);
  }

  /** The signed-in user's entitlements (features, limits, credit balance). */
  getEntitlements(accessToken: string, opts?: { organizationId?: string }): Promise<EntitlementsDto> {
    const qs = opts?.organizationId ? `?organizationId=${encodeURIComponent(opts.organizationId)}` : '';
    return this.selfService<EntitlementsDto>('GET', `/api/v1/billing/entitlements${qs}`, undefined, accessToken);
  }

  /** The signed-in user's own payment history, newest first. */
  listPayments(accessToken: string, limit?: number): Promise<PortalPaymentDto[]> {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return this.selfService<PortalPaymentDto[]>('GET', `/api/v1/billing/payments${qs}`, undefined, accessToken);
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
      throw new RelipayError({
        code: 'CONFIG_MISSING_PUBLISHABLE_KEY',
        message: `@relipay/react: ${path} needs a publishable key.`,
        fix: 'Pass publishableKey to RelipayBrowserClient / <RelipayProvider publishableKey="rp_pub_…">.',
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
      throw new RelipayError({
        code: 'CONFIG_MISSING_PUBLISHABLE_KEY',
        message: `@relipay/react: ${path} needs a publishable key.`,
        fix: 'Pass publishableKey to RelipayBrowserClient / <RelipayProvider publishableKey="rp_pub_…">.',
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
        ...(opts.accessToken ? { 'X-Relipay-User-Token': opts.accessToken } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: 'include',
    });
    const json = (await res.json().catch(() => ({}))) as
      | { success: true; data: T }
      | { success: false; error: RelipayErrorShape };
    if (!res.ok || ('success' in json && json.success === false)) {
      const err =
        'error' in json
          ? json.error
          : { code: 'UNKNOWN_ERROR', message: `HTTP ${res.status}` };
      throw new RelipayError({ ...err, statusCode: res.status });
    }
    return { data: (json as { success: true; data: T }).data, status: res.status };
  }
}

export type {
  EndUserDto,
  ProvidersListDto,
  BillingProviderInfoDto,
  BillingProvider,
} from '@relipay/shared-types';
