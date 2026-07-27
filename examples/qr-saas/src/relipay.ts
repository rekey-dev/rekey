/**
 * Rekey wiring for the QR SaaS sample.
 *
 * Two clients live here:
 *
 *  1. `rekey` — the @rekey.dev/node server SDK, constructed with the
 *     Application's secret key. This is what the QR app uses at runtime for
 *     auth, usage metering, entitlement reads, checkout, credits, orgs.
 *
 *  2. `TenantAdmin` — a thin typed wrapper over the Rekey *tenant operator*
 *     REST API (`/api/v1/tenant/...`). The server SDK deliberately does NOT
 *     expose tenant-operator surfaces (creating Applications, usage meters,
 *     plans, plan entitlements) because those are panel-side / one-time
 *     provisioning, not per-request app logic. We need them to provision the
 *     QR product though, so we hit the REST API directly with the operator
 *     session token. In production you'd do this once, by hand, in the panel.
 *
 * Browser usage (FYI): a React frontend would use `@rekey.dev/react` with the
 * Application's *public* key — never the secret key. e.g.
 *
 *   import { ReliPayProvider, useAuth } from '@rekey.dev/react';
 *   <ReliPayProvider apiUrl={API} publicKey={PUBLIC_KEY}>...</ReliPayProvider>
 *   const { user, signIn, signOut } = useAuth();
 *
 * The browser SDK holds the session and calls the same /api/v1/auth/* and
 * /api/v1/billing/* endpoints this server SDK calls, but with the public key.
 */

import { Rekey } from '@rekey.dev/node';

export const RELIPAY_URL = process.env.RELIPAY_URL ?? 'http://localhost:3050';

/** Construct the runtime server SDK client from a minted secret key. */
export function makeClient(secretKey: string): Rekey {
  return new Rekey({ apiUrl: RELIPAY_URL, secretKey });
}

/** Shape of the `{ success, data }` envelope the Rekey API returns. */
type Envelope<T> = { success: true; data: T } | { success: false; error: ApiError };
export interface ApiError {
  code: string;
  message: string;
  fix?: string;
  requestId?: string;
}

/** A typed error carrying Rekey's structured error body + HTTP status. */
export class TenantApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fix?: string;
  constructor(status: number, error: ApiError) {
    super(`[${error.code}] ${error.message}`);
    this.name = 'TenantApiError';
    this.code = error.code;
    this.status = status;
    this.fix = error.fix;
  }
}

/**
 * Minimal client for the tenant operator REST surface. Authenticated with the
 * operator session access token (a `to_access` JWT from /tenant/auth/sign-in).
 */
export class TenantAdmin {
  constructor(
    private readonly baseUrl: string,
    private accessToken: string,
  ) {}

  setToken(token: string): void {
    this.accessToken = token;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (!res.ok || ('success' in json && json.success === false)) {
      const error: ApiError =
        'error' in json && json.error
          ? json.error
          : { code: `HTTP_${res.status}`, message: `Request failed: ${res.status}` };
      throw new TenantApiError(res.status, error);
    }
    return (json as { success: true; data: T }).data;
  }

  // ---- Tenant operator auth ----

  static async signUp(
    baseUrl: string,
    input: { email: string; password: string; name: string; workspaceName: string },
  ): Promise<TenantSession> {
    const res = await fetch(`${baseUrl}/api/v1/tenant/auth/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = (await res.json().catch(() => ({}))) as Envelope<TenantSession>;
    if (!res.ok || ('success' in json && json.success === false)) {
      const error: ApiError =
        'error' in json && json.error ? json.error : { code: `HTTP_${res.status}`, message: 'sign-up failed' };
      throw new TenantApiError(res.status, error);
    }
    return (json as { success: true; data: TenantSession }).data;
  }

  // ---- Applications ----

  createApplication(input: {
    name: string;
    slug: string;
    enableBilling?: boolean;
    billingProvider?: 'stripe' | 'paypal' | 'razorpay';
  }): Promise<AppDto> {
    return this.req('POST', '/api/v1/tenant/applications/', input);
  }

  patchAuthConfig(appId: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.req('PATCH', `/api/v1/tenant/applications/${appId}/auth-config`, patch);
  }

  patchBillingConfig(appId: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.req('PATCH', `/api/v1/tenant/applications/${appId}/billing-config`, patch);
  }

  mintApiKey(
    appId: string,
    input: { name: string; mode: 'live' | 'test'; scopes?: string[] },
  ): Promise<{ apiKey: { id: string }; rawKey: string; warning: string }> {
    // NOTE: this endpoint returns the SECRET key only. The Application's
    // browser-safe public key (`rp_pub_…`, needed for @rekey.dev/react) is NOT
    // in this response — you have to read it separately from
    // `rekey.applications.me()`. See getApplication() below.
    return this.req('POST', `/api/v1/tenant/applications/${appId}/api-keys`, input);
  }

  /** Read the full Application record (includes the browser-safe `publicKey`). */
  getApplication(appId: string): Promise<AppDto & { publicKey: string }> {
    return this.req('GET', `/api/v1/tenant/applications/${appId}`);
  }

  // ---- Usage meters ----

  createMeter(appId: string, input: { slug: string; name: string; unit: string }): Promise<MeterDto> {
    return this.req('POST', `/api/v1/tenant/applications/${appId}/usage-meters`, input);
  }

  // ---- Plans + entitlements ----

  createPlan(appId: string, input: PlanInput): Promise<PlanDto> {
    return this.req('POST', `/api/v1/tenant/applications/${appId}/plans`, input);
  }

  upsertEntitlement(appId: string, planSlug: string, input: EntitlementInput): Promise<unknown> {
    return this.req('PUT', `/api/v1/tenant/applications/${appId}/plans/${planSlug}/entitlements`, input);
  }

  listEntitlements(appId: string, planSlug: string): Promise<unknown[]> {
    return this.req('GET', `/api/v1/tenant/applications/${appId}/plans/${planSlug}/entitlements`);
  }

  // ---- Billing credentials (BYO Stripe webhook secret) ----

  setStripeCredentials(
    appId: string,
    input: { apiKey: string; webhookSecret: string; enabled?: boolean; mode?: 'test' | 'live' },
  ): Promise<unknown> {
    // PUT /:id/billing-credentials/:provider — body is { data: {...}, enabled, mode }.
    return this.req('PUT', `/api/v1/tenant/applications/${appId}/billing-credentials/stripe`, {
      data: { apiKey: input.apiKey, webhookSecret: input.webhookSecret },
      enabled: input.enabled ?? true,
      mode: input.mode ?? 'test',
    });
  }
}

export interface TenantSession {
  user: { id: string; email: string };
  activeTenantId: string;
  accessToken: string;
  refreshToken: string;
}

export interface AppDto {
  id: string;
  slug: string;
  name: string;
}

export interface MeterDto {
  id: string;
  slug: string;
  name: string;
  unit: string;
}

export interface PlanDto {
  id: string;
  slug: string;
  name: string;
  amount: number;
}

export interface PlanInput {
  slug: string;
  name: string;
  amount: number;
  currency?: string;
  interval?: 'MONTH' | 'YEAR';
  kind?: 'SUBSCRIPTION' | 'LICENSE' | 'USAGE' | 'CREDIT';
  creditsAmount?: number;
}

export interface EntitlementInput {
  kind: 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';
  key?: string;
  valueType?: 'BOOL' | 'INT' | 'STRING';
  value?: string;
  quantity?: number;
  rollover?: boolean;
}
