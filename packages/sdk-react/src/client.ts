/**
 * Browser-side Rekey client.
 *
 * Two credentials, never the secret key:
 *   1. **Publishable key** (`rp_pub_…`). A browser-safe Application credential
 *      passed once at construction. It authorizes the **public-bootstrap**
 *      calls a signed-out user makes, sign-up, sign-in, magic-link, passkey
 *      authenticate, license verify, plan + provider listing, so a frontend/mobile/
 *      desktop app needs NO backend to log users in. It only identifies the
 *      app; it grants nothing on its own (sign-in still needs the password,
 *      license verify still needs the license key).
 *   2. **User JWT** (per call). Once signed in, per-user reads use the short
 *      lived access token via the `X-Rekey-User-Token` header.
 *
 * The secret key (`rp_live_*` / `rp_test_*`) NEVER belongs in the browser. Note
 * what that does and does not rule out: the self-service tier, checkout,
 * cancel own subscription, own entitlements, own payments, own orgs, runs on
 * the publishable key PLUS the user's own token and acts only on that user's
 * resources, which is what makes a backendless portal possible. What stays
 * secret-key-only is the operator/tenant surface and any read across users; use
 * `@rekey.dev/node` from your server for those.
 *
 * `apiUrl` is required. Bring-your-own fetch is supported for SSR/SSE shims
 * and tests.
 */

import type {
  CurrentUserDto,
  EndUserDto,
  EndUserLicenseDto,
  FeatureCheckDto,
  PublicPlanDto,
  RekeyErrorShape,
  SignUpRequest,
  SignInRequest,
  MfaVerifyRequest,
  AuthResultDto,
  SignInOutcomeDto,
  LicenseVerifyResultDto,
  SubscriptionDto,
  CreateCheckoutRequest,
  CheckoutResultDto,
  OrganizationWithRoleDto,
  ProvidersListDto,
  TrialEligibilityDto,
  EndUserDeviceDto,
  DeviceStatusType,
  ListPage,
  MeInclude,
  MeIncludedFor,
  Paged,
  UsageRemainingDto,
  SelfCreditLedgerEntryDto,
} from '@rekey.dev/shared-types';
// NOTE the subpath. `RekeyError` is the ONLY value this package imports from
// shared-types, everything above is a type and erases. Importing it from the
// barrel made every bundle that touches this module keep zod plus ~60
// module-scope `z.object(...)` calls alive: `useUser` alone measured 74,556
// bytes minified. `@rekey.dev/shared-types/error` has zero imports, and the
// same import measured 902 bytes. Same class, same `instanceof`. Keep it.
import { RekeyError } from '@rekey.dev/shared-types/error';

/**
 * `?include=` for `GET /auth/me`, deduplicated. The API ignores order and
 * duplicates too; this keeps the URL short and stable for caching.
 */
function meIncludeQuery(include: readonly MeInclude[] | undefined): string {
  const values = [...new Set(include ?? [])];
  return values.length > 0 ? `?include=${values.join(',')}` : '';
}

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

/** A row from `GET /billing/payments`, the signed-in user's own payment. */
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

// RekeyError is the shared class (imported above), re-exported so the public
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
   * Hits `GET /api/v1/auth/me`, a user-token-only endpoint: it resolves the
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

  /**
   * `getCurrentUser` plus the extras `include` names, from the same
   * user-token-only `GET /api/v1/auth/me`: `entitlements`, `device` (the
   * device this session is bound to, or null), `subscription`,
   * `organization` (the active organization with the caller's role) and
   * `licenses` (`{ items, truncated }`, the first 100 of `listMyLicenses`). With a
   * literal list (inline or `as const`) the return type gains exactly those
   * properties; with a list typed `MeInclude[]` they are optional. Null on
   * USER_TOKEN_INVALID, like `getCurrentUser`.
   *
   * @example
   * ```ts
   * const me = await client.getMe(accessToken, { include: ['entitlements'] });
   * if (me?.entitlements.features.reports) showReports();
   * ```
   */
  async getMe<const L extends readonly MeInclude[] = []>(
    accessToken: string,
    options: { include?: L; meEndpoint?: string } = {},
  ): Promise<(CurrentUserDto & MeIncludedFor<L>) | null> {
    const path = `${options.meEndpoint ?? '/api/v1/auth/me'}${meIncludeQuery(options.include)}`;
    try {
      const res = await this.raw<CurrentUserDto & MeIncludedFor<L>>('GET', path, undefined, { accessToken });
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
   * Authenticate (email + password). Returns a `SignInOutcome`, branch on
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

  /** Begin a passkey authentication ceremony, forward `options` to `navigator.credentials.get`. */
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
   * List the Application's active plans (public catalogue, for pricing pages).
   *
   * Returns the `{items, page}` envelope, not a bare array: a pricing page that
   * quietly renders the first 50 of 80 plans is a pricing page that is wrong,
   * and only `page.total` can tell you that happened. Pass `page.offset` for
   * the next window.
   *
   * Each plan carries `checkout.ready`: false when a buyer sent to checkout
   * for it would be refused, so the page can hide it. Keep the free tier in:
   * with no provider connected it reads `ready: false` and still applies.
   */
  getPlans(page?: ListPage): Promise<Paged<PublicPlanDto>> {
    return this.bootstrap<Paged<PublicPlanDto>>('GET', `/api/v1/billing/plans${listQuery(page)}`, undefined);
  }

  /**
   * The billing providers enabled for this Application, in the order the geo
   * router prefers them (the first is the default pick). Powers a "Pay with…"
   * picker at checkout, feed the result straight into `<ProviderPicker>`.
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
   * The current subscription, the user's own by default, or an organization's
   * when `opts.organizationId` is passed (org-billed apps; caller must be a
   * member). Returns null when there's no active/pending/past-due subscription.
   *
   * `opts.includeEnded` falls back to the most recent CANCELED/EXPIRED
   * subscription **only when the answer would otherwise be null**, so a
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
   * The signed-in user's included quota, usage and remaining units this
   * period, per meter (or one meter with `{ meter }`). `remaining` is what the
   * next record is measured against, so "3 of 100 left" is what the server
   * will enforce. The active organization's quota in an Application that bills
   * organizations; `{ organizationId }` (member-only) picks one.
   */
  getUsageRemaining(
    accessToken: string,
    opts?: { meter?: string; organizationId?: string },
  ): Promise<UsageRemainingDto> {
    const p = new URLSearchParams();
    if (opts?.meter) p.set('meter', opts.meter);
    if (opts?.organizationId) p.set('organizationId', opts.organizationId);
    const qs = p.toString() ? `?${p.toString()}` : '';
    return this.selfService<UsageRemainingDto>('GET', `/api/v1/usage/remaining${qs}`, undefined, accessToken);
  }

  /**
   * The signed-in user's own credit ledger, newest first (their active
   * organization's pool in an Application that bills organizations). Entries
   * carry no `metadata`; that stays with your backend.
   */
  listMyCreditLedger(
    accessToken: string,
    opts?: ListPage & { organizationId?: string },
  ): Promise<Paged<SelfCreditLedgerEntryDto>> {
    const p = new URLSearchParams();
    if (opts?.organizationId) p.set('organizationId', opts.organizationId);
    if (opts?.limit !== undefined) p.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) p.set('offset', String(opts.offset));
    const qs = p.toString() ? `?${p.toString()}` : '';
    return this.selfService<Paged<SelfCreditLedgerEntryDto>>(
      'GET',
      `/api/v1/credits/me/ledger${qs}`,
      undefined,
      accessToken,
    );
  }

  /**
   * One feature for the signed-in user: `{ key, granted, value }`. `value` is
   * what `features[key]` holds in `getEntitlements` (null when nothing grants
   * it); `granted` is `Boolean(value)`. Same subject as
   * `getMe(token, { include: ['entitlements'] })`, or the organization you pass.
   */
  getFeature(accessToken: string, key: string, opts?: { organizationId?: string }): Promise<FeatureCheckDto> {
    const qs = opts?.organizationId ? `?organizationId=${encodeURIComponent(opts.organizationId)}` : '';
    return this.selfService<FeatureCheckDto>(
      'GET',
      `/api/v1/billing/entitlements/features/${encodeURIComponent(key)}${qs}`,
      undefined,
      accessToken,
    );
  }

  /**
   * Whether the signed-in user holds a feature: a false flag, a 0 limit and an
   * unknown key are all `false`. Use `getFeature` to read a numeric limit.
   */
  async hasFeature(accessToken: string, key: string, opts?: { organizationId?: string }): Promise<boolean> {
    return (await this.getFeature(accessToken, key, opts)).granted;
  }

  /**
   * The signed-in user's own licences, newest first, plus the active
   * organization's in an org-billed Application. No raw keys, only each
   * licence's display `keyPrefix`.
   */
  listMyLicenses(accessToken: string, page?: ListPage): Promise<Paged<EndUserLicenseDto>> {
    return this.selfService<Paged<EndUserLicenseDto>>(
      'GET',
      `/api/v1/users/me/licenses/${listQuery(page)}`,
      undefined,
      accessToken,
    );
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

  /**
   * Start a hosted-checkout session for the signed-in user. Returns the
   * redirect URL.
   *
   * A buyer who has already used their free trial is refused with
   * `BILLING_TRIAL_ALREADY_USED` (409). The escape hatch is
   * `allowWithoutTrial: true` plus a fresh `Idempotency-Key`, but send it only
   * after the buyer has been told they are paying today: read
   * {@link getTrialEligibility} and render the paid price rather than retrying
   * blindly, or someone who merely abandoned a trial checkout gets charged
   * today for the trial the next one was about to grant.
   */
  createCheckout(
    accessToken: string,
    input: CreateCheckoutRequest & { couponCode?: string },
  ): Promise<CheckoutResultDto> {
    return this.selfService<CheckoutResultDto>('POST', '/api/v1/billing/checkout', input, accessToken);
  }

  /**
   * Put the signed-in user on the Application's free tier
   * (`billingConfig.defaultPlanSlug`). No payment provider is involved, so this
   * works on an Application with no billing credentials configured at all.
   *
   * This is what a freemium signup calls to hand a new user their included
   * credits, licence or quota: `defaultPlanSlug` alone only covers feature
   * flags and included usage, while CREDIT and LICENSE entitlements need a real
   * subscription, which is what this creates.
   *
   * **Idempotent**, and the result says which happened: `activated: true` is a
   * first activation, `activated: false` means they were already entitled and
   * nothing was written or re-announced.
   *
   * @throws {RekeyError} `BILLING_NO_FREE_PLAN` (404) when no default plan is
   * nominated; `BILLING_FREE_PLAN_NOT_FREE` (409) when that plan charges money,
   * use {@link createCheckout}; `BILLING_FREE_TIER_ALREADY_CLAIMED` (409) when
   * the plan grants credits or a licence and this user already claimed it for
   * another beneficiary.
   */
  async subscribe(
    accessToken: string,
    opts?: { organizationId?: string },
  ): Promise<{ subscription: SubscriptionDto; activated: boolean }> {
    const res = await this.selfServiceWithStatus<SubscriptionDto>(
      'POST',
      '/api/v1/billing/subscribe',
      { ...(opts?.organizationId ? { organizationId: opts.organizationId } : {}) },
      accessToken,
    );
    // 201 = just activated, 200 = already on it. Same body either way, so the
    // status is the only place that distinction exists.
    return { subscription: res.data, activated: res.status === 201 };
  }

  /**
   * Whether the signed-in user may start each plan's free trial.
   *
   * Read this before offering one and feed `items` straight into
   * `<PricingTable trialEligibility={…}>`: a buyer who is not eligible should
   * see the paid price rather than a trial checkout will refuse with
   * `BILLING_TRIAL_ALREADY_USED`.
   *
   * **Advisory.** The real decision is taken under a lock at checkout, so two
   * tabs can both read `eligible: true` and only one gets the trial.
   *
   * **Provider-dependent.** The response echoes the `provider` these answers
   * were resolved against; re-read it when the buyer picks a different
   * processor, because a plan can be unbuyable on one and fine on another.
   */
  getTrialEligibility(
    accessToken: string,
    opts?: { organizationId?: string; planSlug?: string; limit?: number; offset?: number },
  ): Promise<TrialEligibilityDto> {
    const params = new URLSearchParams();
    if (opts?.organizationId) params.set('organizationId', opts.organizationId);
    if (opts?.planSlug) params.set('planSlug', opts.planSlug);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    const query = params.toString();
    return this.selfService<TrialEligibilityDto>(
      'GET',
      `/api/v1/billing/trial-eligibility${query ? `?${query}` : ''}`,
      undefined,
      accessToken,
    );
  }

  // ---------- Device self-service (publishable key + the user's own token) ----------

  /**
   * The signed-in user's own devices, newest activity first.
   *
   * The device the current session is bound to is the one whose `id` matches
   * the access token's `dev` claim, so a "your signed-in machines" screen can
   * mark "this device" without another call. Operator notes and IPs are not on
   * this surface.
   */
  listMyDevices(
    accessToken: string,
    opts?: { status?: DeviceStatusType; limit?: number; offset?: number },
  ): Promise<Paged<EndUserDeviceDto>> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    const query = params.toString();
    return this.selfService<Paged<EndUserDeviceDto>>(
      'GET',
      `/api/v1/users/me/devices/${query ? `?${query}` : ''}`,
      undefined,
      accessToken,
    );
  }

  /**
   * Release one of the signed-in user's own devices.
   *
   * This is the flow `DEVICE_LIMIT_REACHED` names: that refusal carries
   * `details.limit` and `details.devices`, so a sign-in blocked at the device
   * cap can show the user their machines and release one here instead of
   * leaving them stuck.
   *
   * Revokes every session minted on that device, INCLUDING the current one when
   * it is the same device, so treat releasing the token's own `dev` as a sign
   * out. Idempotent for an already-released device; a BLOCKED device refuses
   * with `DEVICE_BLOCKED`, which only an operator can lift.
   */
  releaseMyDevice(
    accessToken: string,
    deviceId: string,
  ): Promise<{ device: EndUserDeviceDto; sessionsRevoked: number }> {
    return this.selfService<{ device: EndUserDeviceDto; sessionsRevoked: number }>(
      'DELETE',
      `/api/v1/users/me/devices/${encodeURIComponent(deviceId)}`,
      undefined,
      accessToken,
    );
  }

  // ---------- internals ----------

  /** Self-service call, sends BOTH the publishable key (app) and the user token. */
  private selfService<T>(method: string, path: string, body: unknown, accessToken: string): Promise<T> {
    return this.selfServiceWithStatus<T>(method, path, body, accessToken).then((r) => r.data);
  }

  /**
   * The same call, keeping the HTTP status.
   *
   * Only `POST /billing/subscribe` needs it: it answers 201 when it activated
   * the free tier and 200 when the caller already had it, with the same
   * Subscription body either way, so the status is the only thing that tells
   * "you are now on it" from "you already were".
   */
  private selfServiceWithStatus<T>(
    method: string,
    path: string,
    body: unknown,
    accessToken: string,
  ): Promise<RawResp<T>> {
    if (!this.publishableKey) {
      throw new RekeyError({
        code: 'CONFIG_MISSING_PUBLISHABLE_KEY',
        message: `@rekey.dev/react: ${path} needs a publishable key.`,
        fix: 'Pass publishableKey to RekeyBrowserClient / <RekeyProvider publishableKey="rp_pub_…">.',
      });
    }
    return this.raw<T>(method, path, body, { publishable: true, accessToken });
  }

  /** Bootstrap call, sends the publishable key as the Application credential. */
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
  // What `getMe()` resolves to before any include.
  CurrentUserDto,
  // `listMyLicenses()`, `getFeature()` and `getPlans()` rows.
  EndUserLicenseDto,
  FeatureCheckDto,
  PublicPlanDto,
  PublicPlanCheckoutDto,
  // `getMe({ include })`: the accepted values and what each one adds.
  MeInclude,
  MeIncluded,
  MeIncludedFor,
  MeIncludedFields,
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
  // What `getTrialEligibility()` resolves to, and the per-plan answer inside
  // it, so a pricing page can name the shape it renders from.
  TrialEligibilityDto,
  TrialEligibilityItemDto,
  TrialPolicyType,
  // What `listMyDevices()` / `releaseMyDevice()` resolve to, plus the `details`
  // payload on the DEVICE_LIMIT_REACHED refusal they exist to answer.
  EndUserDeviceDto,
  DeviceLimitDetails,
  DeviceStatusType,
  // What `getUsageRemaining()` and `listMyCreditLedger()` resolve to.
  UsageRemainingDto,
  UsageMeterRemainingDto,
  SelfCreditLedgerEntryDto,
} from '@rekey.dev/shared-types';
