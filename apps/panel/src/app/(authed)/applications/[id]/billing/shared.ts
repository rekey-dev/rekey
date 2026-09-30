/**
 * Reads, labels and error copy shared by the billing tabs.
 *
 * Every fetcher goes through `apiGet`, which is `React.cache`d per request, so
 * two tabs asking for the provider list in one render cost one round trip.
 */

import {
  apiGet,
  unlessBusy,
  type BillingCredentialRow,
  type BillingProviderDescriptor,
  type PlanRow,
  type SecurityEventRow,
} from '@/lib/api';
import { emptyPage, type Page } from '@/lib/paginate';
import { publicHttpUrl } from '@/lib/public-url';

export interface WebhookEventRow {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  status: 'processed' | 'error' | 'received';
  receivedAt: string;
  processedAt: string | null;
  processingError: string | null;
}

export function billingBase(applicationId: string): string {
  return `/applications/${applicationId}/billing`;
}

function appPath(applicationId: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}`;
}

/** Every registered provider module plus this Application's configured status. */
export async function getBillingProviders(applicationId: string): Promise<BillingProviderDescriptor[]> {
  const res = await apiGet<{ providers: BillingProviderDescriptor[] }>(
    `${appPath(applicationId)}/billing/providers`,
  );
  return res.providers;
}

export function getWebhookEvents(applicationId: string): Promise<Page<WebhookEventRow>> {
  return apiGet<Page<WebhookEventRow>>(
    `${appPath(applicationId)}/billing-credentials/webhook-events?limit=25`,
  ).catch(unlessBusy(() => emptyPage<WebhookEventRow>(25)));
}

/** Null when the plans could not be read, so a page never reports "no active plans" for a failed request. */
export function getPlans(applicationId: string): Promise<Page<PlanRow> | null> {
  return apiGet<Page<PlanRow>>(`${appPath(applicationId)}/plans`, { interruptOnAccessError: false }).catch(
    unlessBusy(() => null),
  );
}

/** How far back the unregistered-return-URL notice looks. */
export const RETURN_URL_NOTICE_DAYS = 7;

/**
 * Checkouts that sent buyers to an origin this Application never registered.
 * The security log is OWNER/ADMIN only; anyone else simply sees no notice.
 */
export function getReturnUrlEvents(applicationId: string): Promise<Page<SecurityEventRow>> {
  // Rounded to the hour so the path, and with it the per-request cache key, is
  // the same for every caller in one render.
  const hour = 60 * 60 * 1000;
  const since = new Date(Math.floor(Date.now() / hour) * hour - RETURN_URL_NOTICE_DAYS * 24 * hour);
  const q = new URLSearchParams({
    applicationId,
    type: 'app.checkout_return_url_unregistered',
    from: since.toISOString(),
    limit: '50',
  });
  return apiGet<Page<SecurityEventRow>>(`/api/v1/tenant/security-events?${q.toString()}`, {
    interruptOnAccessError: false,
  }).catch(unlessBusy(() => emptyPage<SecurityEventRow>(50)));
}

/** Distinct origins named by the unregistered-return-URL events in view. */
export function unregisteredOrigins(events: SecurityEventRow[]): string[] {
  const origins = new Set<string>();
  for (const e of events) {
    const listed = e.metadata.origins;
    if (!Array.isArray(listed)) continue;
    for (const o of listed) if (typeof o === 'string') origins.add(o);
  }
  return [...origins];
}

export function isInboundOnly(d: BillingProviderDescriptor): boolean {
  return d.capabilities.checkout === false;
}

/**
 * Configured-credential rows rebuilt from the discovery statuses, in the shape
 * `GET /billing-credentials` returns, which is what `BillingModeNotice` reads.
 */
export function credentialRows(providers: BillingProviderDescriptor[]): BillingCredentialRow[] {
  return providers
    .filter((d) => d.status !== null)
    .map((d) => ({ provider: d.name, configured: true, ...d.status! }));
}

/**
 * Active plans no configured provider will honour. PENDING and FAILED are
 * excluded: those have their own state and their own repair on the Plans page,
 * and this is about the ones that look healthy.
 */
export function unbuyablePlans(plans: PlanRow[]): PlanRow[] {
  return plans.filter(
    (p) =>
      p.active &&
      p.checkout?.ready === false &&
      p.registrationStatus !== 'PENDING' &&
      p.registrationStatus !== 'FAILED',
  );
}

/**
 * True when every blocked live plan is blocked only because the Application
 * sells through an external system. That is a configuration, not a broken
 * registration, and gets a note rather than the red banner.
 */
export function soldExternally(blocked: PlanRow[]): boolean {
  return (
    blocked.length > 0 &&
    blocked.every((p) => (p.checkout?.blockers ?? []).every((b) => b.code === 'PROVIDER_INBOUND_ONLY'))
  );
}

/**
 * The public API origin a provider can reach. The webhook URL is pasted into
 * the provider's dashboard, so an in-cluster `REKEY_URL` such as
 * `http://api:3030` must never be shown. Null renders a "set
 * NEXT_PUBLIC_API_URL" warning instead of a URL that fails forever.
 */
export function publicApiBase(): string | null {
  return publicHttpUrl(process.env.NEXT_PUBLIC_API_URL) ?? publicHttpUrl(process.env.REKEY_URL);
}

/** The URL a provider posts to. An inbound-only module lives on the generic ingress route. */
export function webhookUrlFor(d: BillingProviderDescriptor, appSlug: string): string | null {
  const base = publicApiBase();
  if (!base) return null;
  const name = encodeURIComponent(d.name);
  return isInboundOnly(d)
    ? `${base}/api/v1/webhooks/billing/${name}/${appSlug}`
    : `${base}/api/v1/billing/webhook/${name}/${appSlug}`;
}

/**
 * Fallback labels for banner lookups on names outside the fetched registry
 * (a stale `?saved=`). The discovery `label` is the source of truth.
 */
const FALLBACK_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  razorpay: 'Razorpay',
};

export function providerLabel(providers: BillingProviderDescriptor[], name: string): string {
  return (
    providers.find((d) => d.name === name)?.label ??
    FALLBACK_LABEL[name] ??
    (name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1))
  );
}

export const BILLING_ERR: Record<string, string> = {
  BILLING_CREDENTIALS_INVALID: 'Credentials format invalid for this provider. Check key prefixes.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can configure billing.',
  BILLING_CREDENTIALS_NOT_CONFIGURED: 'Save the provider credentials first, then auto-configure the webhook.',
  BILLING_WEBHOOK_BASE_NOT_PUBLIC:
    'Webhook auto-config needs a public API URL. Set PUBLIC_WEBHOOK_BASE_URL on the API deployment (or an ngrok tunnel in dev).',
  BILLING_WEBHOOK_AUTOCONFIG_UNSUPPORTED:
    'This provider has no webhook-create API. Configure its webhook manually in the dashboard.',
  BILLING_WEBHOOK_REGISTRATION_FAILED:
    'The provider rejected webhook setup, usually wrong credentials or the wrong mode (live keys with mode=test). Re-check the API key/secret + mode, then retry.',
  INTERNAL_ERROR: 'Something went wrong. Check the API logs for the request id.',
  CHECKOUT_READINESS_FAILED:
    'The Rekey checkout page is not ready for that mode. Fix each FAIL under Readiness on this tab, then switch again.',
};
