/**
 * Server-only API client for the admin surface.
 *
 * Calls `/api/v1/admin/*` with `Authorization: Bearer ${SUPER_ADMIN_KEY}`.
 * The key is read from the admin container's env on each call — it is
 * NEVER returned to the browser, NEVER cached in a global, and NEVER read
 * from a cookie. The browser only carries the opaque session id (see auth.ts).
 *
 * Every response is unwrapped from Rekey's `{success:true,data}` envelope.
 * On a non-2xx we throw `AdminApiError` so server-component pages can render
 * an inline error rather than crashing the route.
 */

import { headers } from 'next/headers';

export class AdminApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(args: { message: string; statusCode: number; code?: string }) {
    super(args.message);
    this.name = 'AdminApiError';
    this.statusCode = args.statusCode;
    this.code = args.code ?? 'ADMIN_HTTP_ERROR';
  }
}

function apiUrl(): string {
  const url = process.env.REKEY_URL;
  if (!url) {
    throw new AdminApiError({
      message: 'REKEY_URL not set on the admin deployment.',
      statusCode: 500,
      code: 'ADMIN_API_URL_MISSING',
    });
  }
  return url.replace(/\/$/, '');
}

function adminKey(): string {
  const k = process.env.SUPER_ADMIN_KEY ?? '';
  if (k.length < 32) {
    throw new AdminApiError({
      message: 'SUPER_ADMIN_KEY not set on the admin deployment.',
      statusCode: 500,
      code: 'ADMIN_KEY_MISSING',
    });
  }
  return k;
}

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

interface OkEnvelope<T> { success: true; data: T }
interface ErrEnvelope { success: false; error: { code: string; message: string; fix?: string } }

/** GET an admin endpoint and return the unwrapped `data`. */
export async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${adminKey()}`,
      Accept: 'application/json',
      ...(await forwardedClientHeaders()),
    },
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as OkEnvelope<T> | ErrEnvelope;
  if (!res.ok || !('success' in json) || json.success === false) {
    const err = 'error' in json && json.error ? json.error : { code: 'ADMIN_HTTP_ERROR', message: `HTTP ${res.status}` };
    throw new AdminApiError({ message: err.message, statusCode: res.status, code: err.code });
  }
  return (json as OkEnvelope<T>).data;
}

/**
 * Best-effort wrapper — returns `null` on failure so a page can render its
 * other widgets even if one feed is down. Use for non-critical card data;
 * use `adminGet` (which throws) when an error should bubble up to the page.
 *
 * Errors are logged to stderr (`console.warn`) so they reach the container's
 * structured logs even though the page renders an empty/"could not load"
 * state. Without this, a misconfigured `REKEY_URL` or a stale
 * `SUPER_ADMIN_KEY` looked identical to "zero data" to the operator.
 */
export async function adminGetSafe<T>(path: string): Promise<T | null> {
  try {
    return await adminGet<T>(path);
  } catch (err) {
    const msg = err instanceof AdminApiError ? `${err.code} ${err.statusCode} ${err.message}` : String(err);
    console.warn(`[admin] adminGetSafe failed path=${path} error="${msg}"`);
    return null;
  }
}

/**
 * POST an admin endpoint and return the unwrapped `data`. Used by the few
 * mutating admin surfaces (operator-invite mint). Same auth + envelope rules
 * as `adminGet`; throws `AdminApiError` on a non-2xx so a server action can
 * surface an inline error.
 */
export async function adminPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminKey()}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(await forwardedClientHeaders()),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as OkEnvelope<T> | ErrEnvelope;
  if (!res.ok || !('success' in json) || json.success === false) {
    const err = 'error' in json && json.error ? json.error : { code: 'ADMIN_HTTP_ERROR', message: `HTTP ${res.status}` };
    throw new AdminApiError({ message: err.message, statusCode: res.status, code: err.code });
  }
  return (json as OkEnvelope<T>).data;
}

/** DELETE an admin endpoint and return the unwrapped `data`. */
export async function adminDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${adminKey()}`,
      Accept: 'application/json',
      ...(await forwardedClientHeaders()),
    },
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as OkEnvelope<T> | ErrEnvelope;
  if (!res.ok || !('success' in json) || json.success === false) {
    const err = 'error' in json && json.error ? json.error : { code: 'ADMIN_HTTP_ERROR', message: `HTTP ${res.status}` };
    throw new AdminApiError({ message: err.message, statusCode: res.status, code: err.code });
  }
  return (json as OkEnvelope<T>).data;
}

// ---------- DTOs (mirror apps/api/src/modules/admin-metrics) ----------

/**
 * One page of a list endpoint — mirrors the API's `Page<T>` envelope. `total`
 * is the full matching-row count (independent of limit/offset) so the UI can
 * render "X–Y of Z" + page navigation.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Empty page — used as the `adminGetSafe` fallback when a feed is down. */
export function emptyPage<T>(limit = 0): Paginated<T> {
  return { items: [], total: 0, limit, offset: 0 };
}

/** One operator-invite key (mirrors PublicOperatorInvite in the API). */
export interface OperatorInviteRow {
  id: string;
  tokenPrefix: string;
  note: string | null;
  status: 'active' | 'used' | 'revoked' | 'expired';
  expiresAt: string | null;
  usedAt: string | null;
  usedByTenantUserId: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Mint result — the raw key is present exactly once, in this response. */
export interface MintedOperatorInvite {
  invite: OperatorInviteRow;
  rawToken: string;
  warning: string;
}

export interface OverviewMetrics {
  tenants: { total: number; newLast30d: number };
  applications: { total: number; newLast30d: number };
  endUsers: { total: number; verified: number; newLast24h: number; newLast7d: number; newLast30d: number };
  organizations: { total: number; newLast30d: number };
  subscriptions: {
    pending: number;
    active: number;
    pastDue: number;
    canceled: number;
    expired: number;
    total: number;
  };
  payments: { lifetime: { count: number; volumeCents: number }; last30d: { count: number; volumeCents: number }; succeededLast24h: number; failedLast24h: number };
  mrrCents: number;
  /** True when MRR computation saturated its read cap (value is a lower bound). */
  mrrCapped: boolean;
  webhooks: { eventsLast24h: number; deliveriesLast24h: number; deliveriesFailedLast24h: number };
  apiRequests: { last24h: number; errors4xxLast24h: number; errors5xxLast24h: number; avgDurationMs: number };
  tenantUsers: { total: number; activeLast30d: number };
  lockedAccountsCount: number;
  outstandingCredits: number;
  emailLast24h: { sent: number; error: number; noTransport: number; total: number };
}

export interface CreditLiabilityRow {
  applicationId: string;
  applicationSlug: string;
  applicationName: string;
  outstanding: number;
}
export interface CreditLiability {
  totalOutstanding: number;
  perApp: CreditLiabilityRow[];
}

export interface LockedAccountRow {
  id: string;
  applicationId: string;
  applicationSlug: string;
  email: string;
  failedAttempts: number;
  lockedUntil: string;
}
export interface LockedAccounts {
  total: number;
  accounts: LockedAccountRow[];
}

export interface EmailDeliverability {
  last24h: { sent: number; error: number; noTransport: number; total: number };
  last7d: { sent: number; error: number; noTransport: number; total: number };
  topErrorApps: Array<{ applicationId: string; applicationSlug: string; errors: number }>;
}

export interface WebhookEndpointHealthRow {
  endpointId: string;
  url: string;
  applicationId: string;
  applicationSlug: string;
  succeeded: number;
  failed: number;
  pending: number;
  successRate: number | null;
}

export interface PaymentsByAppRow {
  applicationId: string;
  applicationSlug: string;
  applicationName: string;
  succeeded: number;
  failed: number;
  pending: number;
  refunded: number;
  successRate: number | null;
  volumeCents: number;
}

export interface ServiceHealth {
  api: { status: 'up' | 'down'; checkedAt: string };
  database: { status: 'up' | 'down'; latencyMs: number | null };
  redis: { status: 'up' | 'down' | 'not_configured'; latencyMs: number | null };
  webhookDeliverySuccessRate24h: number | null;
  oldestUnprocessedWebhookAgeSeconds: number | null;
}

export interface RetentionMetrics {
  endUsersActive: { last24h: number; last7d: number; last30d: number };
  operatorsActive: { last24h: number; last7d: number; last30d: number };
  signupTrend14d: Array<{ date: string; count: number }>;
}

export interface TenantSummaryRow {
  id: string;
  name: string;
  ownerEmail: string;
  applicationCount: number;
  endUserCount: number;
  organizationCount: number;
  activeSubscriptions: number;
  mrrCents: number;
  /** True when this tenant's MRR sum saturated the read cap. */
  mrrCapped: boolean;
  createdAt: string;
  lastActivityAt: string | null;
}

export interface ApplicationSummaryRow {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  slug: string;
  /**
   * Fixed at creation and immutable. Drives the prefix of the application's
   * secret keys and nothing else — in particular it does NOT restrict which
   * billing credentials the application may hold.
   */
  environment: 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT';
  endUserCount: number;
  activeSubscriptions: number;
  apiRequestsLast24h: number;
  createdAt: string;
}

export interface EndUserRow {
  id: string;
  applicationId: string;
  applicationSlug: string;
  applicationName: string;
  email: string;
  emailVerified: boolean;
  role: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface TenantUserRow {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  membershipCount: number;
}

export interface SecurityEventRow {
  id: string;
  type: string;
  actorType: string;
  actorId: string | null;
  tenantId: string | null;
  tenantName: string | null;
  applicationId: string | null;
  applicationName: string | null;
  applicationSlug: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RequestLogRow {
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

export interface PaymentRow {
  id: string;
  applicationId: string;
  applicationSlug: string;
  endUserId: string | null;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
}

export interface SubscriptionRow {
  id: string;
  applicationId: string;
  applicationSlug: string;
  endUserId: string;
  planSlug: string;
  planName: string;
  status: string;
  currency: string;
  amount: number;
  interval: string;
  createdAt: string;
  currentPeriodEnd: string | null;
}

export interface WebhookEventRow {
  id: string;
  applicationId: string;
  applicationSlug: string;
  provider: string;
  eventType: string;
  receivedAt: string;
  processedAt: string | null;
  processingError: string | null;
}

export interface WebhookDeliveryRow {
  id: string;
  endpointId: string;
  applicationId: string;
  applicationSlug: string;
  eventType: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  createdAt: string;
}
