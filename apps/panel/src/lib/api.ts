/**
 * Panel API client — calls the operator surface (`/api/v1/tenant/*`).
 *
 * Two cookies, both httpOnly + SameSite=Strict + Secure-in-prod:
 *   - relipay_access  — short-lived (15 min) operator JWT
 *   - relipay_refresh — long-lived (30 days) opaque token
 *
 * Auto-refresh on 401: when the access token expires, we exchange the
 * refresh token, rotate cookies, and retry the original request once.
 * If even refresh fails, both cookies are cleared and the user lands on
 * /login?reason=expired.
 *
 * Server-only module — never import from a client component.
 */

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

export const ACCESS_COOKIE = 'relipay_access';
export const REFRESH_COOKIE = 'relipay_refresh';

interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; fix?: string; docs?: string; requestId?: string };
}

export class PanelApiError extends Error {
  public readonly code: string;
  public readonly fix: string | undefined;
  public readonly statusCode: number;
  public readonly requestId: string | undefined;
  constructor(args: {
    code: string;
    message: string;
    fix?: string;
    statusCode: number;
    requestId?: string;
  }) {
    super(args.message);
    this.name = 'PanelApiError';
    this.code = args.code;
    this.fix = args.fix;
    this.statusCode = args.statusCode;
    this.requestId = args.requestId;
  }
}

function apiUrl(): string {
  const url = process.env.RELIPAY_URL;
  if (!url) {
    throw new PanelApiError({
      code: 'PANEL_API_URL_MISSING',
      message: 'RELIPAY_URL is not set on the panel deployment.',
      fix: 'Set RELIPAY_URL=https://your-rekey.example.com in the panel environment.',
      statusCode: 500,
    });
  }
  return url.replace(/\/$/, '');
}

/**
 * Forward the operator's real client IP to the API. The browser→panel→API hop
 * otherwise hides it — the API sees the panel container's address (10.x inside
 * Docker), which is what ends up in the audit log / session list. We read the
 * IP the panel itself received from the edge proxy (X-Forwarded-For, first hop,
 * else X-Real-IP) and pass it through; the API trusts it via `trustProxy` in
 * production. Best-effort: returns {} if headers aren't available.
 */
async function forwardedClientHeaders(): Promise<Record<string, string>> {
  try {
    const h = await headers();
    const xff = h.get('x-forwarded-for');
    const ip = (xff?.split(',')[0] ?? h.get('x-real-ip') ?? '').trim();
    return ip ? { 'x-forwarded-for': ip } : {};
  } catch {
    return {};
  }
}

const ONE_DAY = 60 * 60 * 24;

export async function setSessionCookies(args: {
  accessToken: string;
  refreshToken: string;
}): Promise<void> {
  const jar = await cookies();
  const secure = process.env.NODE_ENV === 'production';
  // `lax`, not `strict`: an operator can legitimately ARRIVE at the panel via a
  // top-level cross-site navigation — most importantly the MCP OAuth consent
  // flow, which enters /mcp-consent through a redirect that originated at the
  // MCP client (claude). `strict` withholds the session on any cross-site-
  // initiated navigation, so the operator looked logged-out and was forced to
  // re-login on every connect attempt. `lax` sends the session on top-level GET
  // navigations while still withholding it on cross-site POST/subresource
  // requests (the CSRF surface). Next server actions carry their own origin check.
  jar.set(ACCESS_COOKIE, args.accessToken, {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 15,
  });
  jar.set(REFRESH_COOKIE, args.refreshToken, {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: ONE_DAY * 30,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

/**
 * Best-effort cookie clear: doesn't throw if called from a server component
 * (Next 15 forbids cookie writes outside server actions / route handlers).
 * Used inside the `api()` 401 handler — if we can't clear inline, the
 * /sign-out redirect picks up and a Route Handler does it.
 */
async function clearSessionCookiesSafe(): Promise<boolean> {
  try {
    await clearSessionCookies();
    return true;
  } catch {
    return false;
  }
}

/** Same try/catch pattern for write — server components can't `set`. */
async function setSessionCookiesSafe(args: {
  accessToken: string;
  refreshToken: string;
}): Promise<boolean> {
  try {
    await setSessionCookies(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt token refresh. Returns the new access token on success, or `null`
 * if refresh failed OR if we couldn't persist the new cookies (caller is in
 * a server-component context and Next 15 won't let us write cookies). The
 * caller treats `null` as "give up, bounce through /sign-out".
 */
async function tryRefresh(): Promise<string | null> {
  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return null;
  try {
    const res = await fetch(`${apiUrl()}/api/v1/tenant/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await forwardedClientHeaders()) },
      body: JSON.stringify({ refreshToken: refresh }),
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => ({}))) as
      | { success: true; data: { accessToken: string; refreshToken: string } }
      | ErrorEnvelope;
    if (!res.ok || !('success' in json) || json.success === false) return null;
    const wrote = await setSessionCookiesSafe({
      accessToken: json.data.accessToken,
      refreshToken: json.data.refreshToken,
    });
    if (!wrote) return null;
    return json.data.accessToken;
  } catch {
    return null;
  }
}

export interface RequestArgs {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  redirectOn401?: boolean;
}

async function callOnce(
  method: string,
  path: string,
  body: unknown,
  accessToken: string | null,
): Promise<Response> {
  return fetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(await forwardedClientHeaders()),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
}

export async function api<T>(args: RequestArgs): Promise<T> {
  const jar = await cookies();
  let access = jar.get(ACCESS_COOKIE)?.value ?? null;

  let res = await callOnce(args.method, args.path, args.body, access);

  if (res.status === 401) {
    const newAccess = await tryRefresh();
    if (newAccess) {
      access = newAccess;
      res = await callOnce(args.method, args.path, args.body, access);
    }
  }

  const json = (await res.json().catch(() => ({}))) as
    | { success: true; data: T }
    | ErrorEnvelope;

  if (!res.ok || ('success' in json && json.success === false)) {
    if (res.status === 401) {
      if (args.redirectOn401 !== false) {
        // Server actions / route handlers can clear cookies inline. Server
        // components can't (Next 15) — bounce through /sign-out which is a
        // Route Handler that does the clear and then redirects to /login.
        const cleared = await clearSessionCookiesSafe();
        if (cleared) {
          redirect('/login?reason=expired');
        } else {
          redirect('/sign-out?reason=expired');
        }
      }
    }
    const err =
      'error' in json
        ? json.error
        : { code: 'PANEL_HTTP_ERROR', message: `HTTP ${res.status}` };
    throw new PanelApiError({ ...err, statusCode: res.status });
  }
  return (json as { success: true; data: T }).data;
}

// ---------- DTOs ----------

export interface MeDto {
  user: { id: string; email: string; name: string | null };
  memberships: Array<{ tenantId: string; tenantName: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }>;
  activeTenantId: string;
  activeRole: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export interface ApplicationRow {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  publicKey: string;
  /** Previous publishable key during a rotation grace window (null otherwise). */
  previousPublicKey?: string | null;
  /** When the previous publishable key stops verifying (null when not rotating). */
  previousPublicKeyValidUntil?: string | null;
  authConfig: {
    methods: string[];
    passwordMinLength: number;
    redirectUrls: string[];
    signupEnabled?: boolean;
    signupMode?: 'public' | 'secret_only' | 'invite_only';
    mfa?: 'off' | 'optional' | 'required';
    mcpEnabled?: boolean;
    organizationsEnabled?: boolean;
    passwordBreachCheckEnabled?: boolean;
  };
  billingConfig: {
    /** Master switch. When false the whole billing surface is gated server-side. */
    enabled: boolean;
    /** Failed-payment recovery (reminders + day-14 auto-cancel). Off by default. */
    dunningEnabled?: boolean;
    /** Default billing subject: individual end-user, or their organization. */
    billingSubject?: 'user' | 'org';
    provider: string;
    currency: string;
    metadata: Record<string, unknown>;
  };
  oauthConfig: Record<string, { clientId: string; redirectUri: string; scopes?: string[] }>;
  /** Per-app network access controls (CIDRs/IPs for secret keys; CORS origins). */
  ipAllowlist?: string[];
  corsOrigins?: string[];
  /** Hosted customer portal (Portal V2) settings. */
  hostedPortalEnabled?: boolean;
  portalDomain?: string | null;
  portalDomainVerifiedAt?: string | null;
  portalBranding?: Record<string, unknown>;
  /** Public MCP server URL, computed API-side from PUBLIC_WEBHOOK_BASE_URL/API_URL. */
  mcpUrl?: string;
  createdAt: string;
}

/** Per-application dashboard stats — GET /tenant/applications/:id/stats. */
export interface ApplicationStatsRow {
  users: {
    total: number;
    verified: number;
    newLast7d: number;
    newLast30d: number;
    signupTrend: Array<{ date: string; count: number }>;
  };
  security: {
    eventsLast30d: number;
    signInsLast30d: number;
    signUpsLast30d: number;
  };
  billing: {
    enabled: boolean;
    activeSubscriptions: number;
    plansActive: number;
    plansTotal: number;
  };
  usage: {
    creditsOutstanding: number;
    usageLast30d: number;
  };
}

export interface SecurityEventRow {
  id: string;
  type: string;
  actorType: string;
  actorId: string | null;
  applicationId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorSessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
}

/** One row of the per-request access log (api_request_logs). */
export interface ApiRequestLogRow {
  id: string;
  method: string;
  routePath: string;
  statusCode: number;
  durationMs: number;
  applicationId: string | null;
  tenantId: string | null;
  operatorUserId: string | null;
  ip: string | null;
  createdAt: string;
}

export interface PlanRow {
  id: string;
  applicationId: string;
  slug: string;
  name: string;
  amount: number;
  currency: string;
  interval: 'MONTH' | 'YEAR';
  kind: 'SUBSCRIPTION' | 'LICENSE' | 'USAGE' | 'CREDIT';
  licenseKind: 'PERPETUAL' | 'TIMED' | 'SEATS' | null;
  licenseSeatsAllowed: number | null;
  licenseDurationDays: number | null;
  meterSlug: string | null;
  pricePerUnitCents: number | null;
  creditsAmount: number | null;
  active: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OrgBillingDto {
  creditBalance: number;
  features: Record<string, boolean | number | string>;
  entitlements: PlanEntitlementRow[];
  subscriptions: Array<{
    id: string;
    planSlug: string;
    planName: string;
    status: string;
    ownerEndUserId: string;
    currentPeriodEnd: string | null;
  }>;
  // Licenses pooled to this org (seats shared by the team).
  licenses: Array<{
    id: string;
    kind: 'PERPETUAL' | 'TIMED' | 'SEATS';
    status: string;
    keyPrefix: string;
    seatsAllowed: number | null;
    ownerEndUserId: string;
    expiresAt: string | null;
  }>;
}

export interface PlanEntitlementRow {
  id: string;
  kind: 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';
  key: string;
  valueType: 'BOOL' | 'INT' | 'STRING' | null;
  value: string | null;
  quantity: number | null;
  licenseKind: 'PERPETUAL' | 'TIMED' | 'SEATS' | null;
  rollover: boolean;
  createdAt: string;
}

export interface UsageMeterRow {
  id: string;
  slug: string;
  name: string;
  unit: string;
  active: boolean;
  createdAt: string;
}

export interface CouponRow {
  id: string;
  code: string;
  discountType: 'PERCENT' | 'AMOUNT';
  amountOff: number;
  currency: string | null;
  planSlugs: string[];
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  maxRedemptionsPerUser: number | null;
  /** Times redeemed (rows in coupon_redemptions). */
  redemptionCount: number;
  /** Total discount granted across redemptions, smallest currency unit (best-effort). */
  totalDiscountIssued: number;
}

/**
 * GET /tenant/applications/:id/billing/stats — revenue dashboard numbers.
 * Live-mode data only: TEST subscriptions/payments are excluded server-side.
 */
export interface BillingStatsRow {
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  canceledLast30d: number;
  newSubscriptionsLast30d: number;
  /** Monthly recurring revenue, smallest currency unit (YEAR plans normalized /12). */
  mrrCents: number;
  /** Currency of `mrrCents` (dominant across active plans); null when no MRR. */
  mrrCurrency: string | null;
  /** True when active subscription plans span more than one currency. */
  mixedCurrencies: boolean;
  revenueLast30dCents: number;
  paymentsLast30d: { succeeded: number; failed: number };
  /** Last 12 UTC months, oldest first, gap-filled. `month` is `YYYY-MM`. */
  monthlyRevenue: Array<{ month: string; amountCents: number }>;
}

/** One row of GET /tenant/applications/:id/payments. */
export interface PaymentRow {
  id: string;
  endUserId: string | null;
  endUserEmail: string | null;
  subscriptionId: string | null;
  amount: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  /** Test/live isolation: TEST = sandbox checkout via an rp_test_* key. */
  mode: 'TEST' | 'LIVE';
  providerPaymentId: string | null;
  description: string | null;
  createdAt: string;
}

/** One row of GET /tenant/applications/:id/dunning — failed-payment recovery. */
export interface DunningCaseRow {
  id: string;
  subscriptionId: string;
  endUserId: string | null;
  endUserEmail: string | null;
  organizationId: string | null;
  status: 'OPEN' | 'RECOVERED' | 'EXHAUSTED' | 'CANCELED';
  /** Test/live isolation: TEST = sandbox dunning case (mirrors PaymentRow). */
  mode: 'TEST' | 'LIVE';
  planSlug: string;
  planName: string;
  failedAttempts: number;
  remindersSent: number;
  lastFailureAt: string | null;
  nextActionAt: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface EndUserRow {
  id: string;
  email: string;
  emailVerified: boolean;
  role: string;
  /** Test/live isolation: TEST = signed up via an rp_test_* key. */
  mode: 'TEST' | 'LIVE';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface EndUserRoleRow {
  id: string;
  applicationId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown> | null;
  memberCount: number;
  pendingInvitationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMemberRow {
  id: string;
  endUserId: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  createdAt: string;
}

export interface OrganizationInvitationRow {
  id: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  expiresAt: string;
  createdAt: string;
}

export interface OrganizationDetail {
  organization: {
    id: string;
    name: string;
    slug: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
  };
  members: OrganizationMemberRow[];
  invitations: OrganizationInvitationRow[];
}

export type EmailLogStatus = 'sent' | 'error' | 'no_transport';

export interface EmailLogRow {
  id: string;
  applicationId: string | null;
  toAddress: string;
  subject: string;
  eventKey: string | null;
  /** byo_resend | byo_smtp | default_resend | none */
  via: string;
  status: EmailLogStatus | string;
  messageId: string | null;
  error: string | null;
  createdAt: string;
}

/** Workspace-wide log row carries the owning app (null for system mail). */
export interface EmailLogWithApp extends EmailLogRow {
  application: { id: string; name: string; slug: string } | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Per-application role a workspace MEMBER can be granted (roadmap #8). */
export type ApplicationGrantRole = 'APP_ADMIN' | 'APP_BILLING' | 'APP_VIEWER';

export interface MemberGrantRow {
  applicationId: string;
  applicationName: string;
  applicationSlug: string;
  role: ApplicationGrantRole;
  createdAt: string;
}

export interface MemberRow {
  membershipId: string;
  tenantUserId: string;
  email: string;
  name: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: string;
  /**
   * Per-application grants. Only meaningful for MEMBER roles. Empty list =
   * legacy mode (read-only on every application); ≥1 grant = the member only
   * sees/uses the granted applications.
   */
  grants: MemberGrantRow[];
}

export interface InvitationRow {
  id: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  expiresAt: string;
  createdAt: string;
  invitedById: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
}

export interface BillingCredentialsStatus {
  configured: boolean;
  provider: string | null;
}

/**
 * Billing provider name. Open string (P4): the set of providers is the API's
 * runtime provider-module registry, discovered via
 * `GET /tenant/applications/:id/billing/providers` — no compile-time union.
 */
export type BillingProviderName = string;

export interface BillingCredentialRow {
  provider: BillingProviderName;
  configured: boolean;
  enabled: boolean;
  mode: 'test' | 'live';
  countries: string[];
  priority: number;
  /** Whether the provider webhook secret/id is set (manually or auto-registered). */
  webhookConfigured: boolean;
}

/** What a provider module can do — from the registry, via discovery (P4). */
export interface BillingProviderCapabilities {
  oneTime: boolean;
  captureStep: boolean;
  /** false → no webhook-create API (Razorpay): manual dashboard setup only. */
  autoWebhookRegister: boolean;
  periodRotationEvents: boolean;
  onlineVerify: boolean;
}

/** One credential form field, as declared by the provider module (never a stored value). */
export interface BillingCredentialFieldInfo {
  key: string;
  label: string;
  /** true → render a password input; the API never echoes it back. */
  secret: boolean;
  optional: boolean;
  placeholder?: string;
  help?: string;
  /** Shape rule ('sk_', 'whsec_'…) reduced to its operator-readable message. */
  pattern?: { message: string };
}

/**
 * One entry of `GET /tenant/applications/:id/billing/providers` (P4): a
 * registered provider module + this application's configured status. Drives
 * the whole panel billing page — provider list, labels, credential forms,
 * webhook UX gating.
 */
export interface BillingProviderDescriptor {
  name: BillingProviderName;
  label: string;
  docsUrl: string;
  defaultCountries: string[];
  priority: number;
  capabilities: BillingProviderCapabilities;
  credentialFields: BillingCredentialFieldInfo[];
  configured: boolean;
  /** null until this application has credentials for the provider. */
  status: {
    enabled: boolean;
    mode: 'test' | 'live';
    countries: string[];
    priority: number;
    webhookConfigured: boolean;
  } | null;
}

// ---------- Unauth helpers (sign-in / sign-up / accept-invite) ----------

/**
 * Discriminated union returned by `/api/v1/tenant/auth/sign-in`. Branch on
 * `mfaRequired`:
 *   - `false` → full session — set cookies and proceed.
 *   - `true`  → MFA enrolled — collect TOTP/backup code and POST to
 *     `/api/v1/tenant/auth/mfa-verify` to receive an `AuthResponse`.
 */
export type SignInResponse =
  | (AuthResponse & { mfaRequired: false })
  | {
      mfaRequired: true;
      user: { id: string; email: string; name: string | null };
      mfaChallengeToken: string;
      mfaChallengeExpiresAt: string;
    };

export interface AuthResponse {
  user: { id: string; email: string; name: string | null };
  memberships: MeDto['memberships'];
  activeTenantId: string;
  activeRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  accessToken: string;
  refreshToken: string;
}

export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await forwardedClientHeaders()) },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as
    | { success: true; data: T }
    | ErrorEnvelope;
  if (!res.ok || !('success' in json) || json.success === false) {
    const err =
      'error' in json
        ? json.error
        : { code: 'PANEL_HTTP_ERROR', message: `HTTP ${res.status}` };
    throw new PanelApiError({ ...err, statusCode: res.status });
  }
  return json.data;
}

export async function publicGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    headers: { ...(await forwardedClientHeaders()) },
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as
    | { success: true; data: T }
    | ErrorEnvelope;
  if (!res.ok || !('success' in json) || json.success === false) {
    const err =
      'error' in json
        ? json.error
        : { code: 'PANEL_HTTP_ERROR', message: `HTTP ${res.status}` };
    throw new PanelApiError({ ...err, statusCode: res.status });
  }
  return json.data;
}

/**
 * Read `/health/ready`.
 *
 * Deliberately NOT routed through `publicGet`: the health endpoints answer a bare
 * `{status, db, redis}` object rather than the `{success, data}` envelope every
 * other route uses, so `publicGet` would treat a perfectly good response as a
 * protocol error and throw. They also answer 503 when a dependency is down, and
 * that body is exactly the one we want to read.
 *
 * Returns null on anything unparseable. A health probe must never be the reason a
 * page fails to render.
 */
export interface ReadyReport {
  status?: string;
  db?: 'ok' | 'unreachable';
  redis?: 'ok' | 'unreachable' | 'not_configured';
}

export async function getReadyReport(): Promise<ReadyReport | null> {
  try {
    const res = await fetch(`${apiUrl()}/health/ready`, {
      // Short cache: enough that a burst of navigations shares one probe, short
      // enough that a resolved outage clears the banner promptly.
      next: { revalidate: 15 },
    });
    const json = (await res.json().catch(() => null)) as ReadyReport | null;
    if (json === null || typeof json !== 'object') return null;
    return json;
  } catch {
    return null;
  }
}
