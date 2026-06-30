import * as React from 'react';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  api,
  PanelApiError,
  type ApplicationRow,
  type BillingCredentialRow,
  type BillingProviderName,
} from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { formatDateTime } from '@/lib/date';
import { Modal } from '@/components/Modal';
import { BillingModeAutodetect } from '@/components/BillingModeAutodetect';
import { BillingModeNotice } from '@/components/BillingModeBanner';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';

interface WebhookEventRow {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  status: 'processed' | 'error' | 'received';
  receivedAt: string;
  processedAt: string | null;
  processingError: string | null;
}

const WEBHOOK_STATUS_TONE: Record<WebhookEventRow['status'], BadgeTone> = {
  processed: 'success',
  received: 'warning',
  error: 'danger',
};

// ---------- Server actions ----------

async function upsertStripe(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  const webhookSecret = String(formData.get('webhookSecret') ?? '').trim();
  const countries = parseCountries(formData.get('countries'));
  const priority = parsePriority(formData.get('priority'));
  const mode = parseMode(formData.get('mode'));
  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/stripe`,
      body: { data: { apiKey, webhookSecret }, countries, priority, mode },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/billing?error=${encodeURIComponent(err.code)}&edit=stripe`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/billing`);
  redirect(`/applications/${applicationId}/billing?saved=stripe`);
}

async function upsertPaypal(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const clientId = String(formData.get('clientId') ?? '').trim();
  const clientSecret = String(formData.get('clientSecret') ?? '').trim();
  const webhookId = String(formData.get('webhookId') ?? '').trim();
  const countries = parseCountries(formData.get('countries'));
  const priority = parsePriority(formData.get('priority'));
  const mode = parseMode(formData.get('mode'));
  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/paypal`,
      body: { data: { clientId, clientSecret, webhookId }, countries, priority, mode },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/billing?error=${encodeURIComponent(err.code)}&edit=paypal`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/billing`);
  redirect(`/applications/${applicationId}/billing?saved=paypal`);
}

async function upsertRazorpay(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const keyId = String(formData.get('keyId') ?? '').trim();
  const keySecret = String(formData.get('keySecret') ?? '').trim();
  const webhookSecret = String(formData.get('webhookSecret') ?? '').trim();
  const countries = parseCountries(formData.get('countries'));
  const priority = parsePriority(formData.get('priority'));
  const mode = parseMode(formData.get('mode'));
  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/razorpay`,
      body: { data: { keyId, keySecret, webhookSecret }, countries, priority, mode },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/billing?error=${encodeURIComponent(err.code)}&edit=razorpay`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/billing`);
  redirect(`/applications/${applicationId}/billing?saved=razorpay`);
}

async function toggleEnabled(
  applicationId: string,
  provider: BillingProviderName,
  enabled: boolean,
): Promise<void> {
  'use server';
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/${provider}`,
    body: { enabled },
  });
  revalidatePath(`/applications/${applicationId}/billing`);
  redirect(`/applications/${applicationId}/billing`);
}

/**
 * Master billing switch for the whole application. Off (default for new apps)
 * gates the entire public billing surface server-side (checkout, subscriptions,
 * plans, coupons, credits, licenses, usage) and hides the Billing tab group.
 */
async function setBillingEnabled(applicationId: string, enabled: boolean): Promise<void> {
  'use server';
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-config`,
      body: { enabled },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/billing?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/billing`);
  redirect(`/applications/${applicationId}/billing?saved=billing`);
}

/**
 * Failed-payment recovery (dunning) opt-in. When on, a subscription that goes
 * PAST_DUE opens a dunning case: reminder emails on day 0/3/7 and an automatic
 * cancel on day 14 (local + provider-side). Off by default — turning it off
 * only stops NEW cases; any case already in flight runs to completion.
 */
async function setDunningEnabled(applicationId: string, dunningEnabled: boolean): Promise<void> {
  'use server';
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-config`,
      body: { dunningEnabled },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/billing?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/billing`);
  redirect(`/applications/${applicationId}/billing?saved=dunning`);
}

async function setBillingSubject(applicationId: string, billingSubject: 'user' | 'org'): Promise<void> {
  'use server';
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-config`,
      body: { billingSubject },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/billing?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/billing`);
  redirect(`/applications/${applicationId}/billing?saved=subject`);
}

async function removeProvider(
  applicationId: string,
  provider: BillingProviderName,
): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/${provider}`,
  });
  revalidatePath(`/applications/${applicationId}/billing`);
  redirect(`/applications/${applicationId}/billing`);
}

async function registerWebhook(
  applicationId: string,
  provider: BillingProviderName,
): Promise<void> {
  'use server';
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/${provider}/register-webhook`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/billing?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/billing`);
  redirect(`/applications/${applicationId}/billing?webhook=${provider}`);
}

function parseCountries(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,\s]+/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length === 2);
}

function parsePriority(raw: FormDataEntryValue | null): number {
  if (typeof raw !== 'string' || raw === '') return 100;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return 100;
  return Math.round(n);
}

function parseMode(raw: FormDataEntryValue | null): 'test' | 'live' {
  return raw === 'live' ? 'live' : 'test';
}

// ---------- Page ----------

const ERR: Record<string, string> = {
  BILLING_CREDENTIALS_INVALID: 'Credentials format invalid for this provider — check key prefixes.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can configure billing.',
  BILLING_CREDENTIALS_NOT_CONFIGURED: 'Save the provider credentials first, then auto-configure the webhook.',
  BILLING_WEBHOOK_BASE_NOT_PUBLIC:
    'Webhook auto-config needs a public API URL. Set PUBLIC_WEBHOOK_BASE_URL on the API deployment (or an ngrok tunnel in dev).',
  BILLING_WEBHOOK_AUTOCONFIG_UNSUPPORTED:
    'This provider has no webhook-create API — configure its webhook manually in the dashboard.',
  BILLING_WEBHOOK_REGISTRATION_FAILED:
    'The provider rejected webhook setup — usually wrong credentials or the wrong mode (live keys with mode=test). Re-check the API key/secret + mode, then retry.',
  INTERNAL_ERROR: 'Something went wrong. Check the API logs for the request id.',
};

const PROVIDER_LABEL: Record<BillingProviderName, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  razorpay: 'Razorpay',
};

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const saved = typeof sp.saved === 'string' ? sp.saved : undefined;
  const edit = typeof sp.edit === 'string' ? sp.edit : undefined;
  const webhook = typeof sp.webhook === 'string' ? sp.webhook : undefined;

  const [app, list, webhookEvents] = await Promise.all([
    api<ApplicationRow>({ method: 'GET', path: `/api/v1/tenant/applications/${encodeURIComponent(id)}` }),
    api<BillingCredentialRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/billing-credentials`,
    }),
    api<WebhookEventRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/billing-credentials/webhook-events?limit=25`,
    }).catch(() => [] as WebhookEventRow[]),
  ]);

  const byProvider = new Map(list.map((r) => [r.provider, r]));
  const billingEnabled = app.billingConfig.enabled;
  const dunningEnabled = app.billingConfig.dunningEnabled ?? false;

  // When RELIPAY_URL is unset the constructed webhook URL would be a relative
  // path — Stripe rejects those silently and the webhook then fails forever
  // (UX-AUDIT MEDIUM #24). Pass `null` to the row + render a "configure
  // RELIPAY_URL" warning so the operator catches this before pasting.
  const apiBase = process.env.RELIPAY_URL?.replace(/\/$/, '');
  const stripeWebhookUrl = apiBase
    ? `${apiBase}/api/v1/billing/webhook/stripe/${app.slug}`
    : null;
  const paypalWebhookUrl = apiBase
    ? `${apiBase}/api/v1/billing/webhook/paypal/${app.slug}`
    : null;
  const razorpayWebhookUrl = apiBase
    ? `${apiBase}/api/v1/billing/webhook/razorpay/${app.slug}`
    : null;

  return (
    <div className="space-y-5">
      {billingEnabled && <BillingModeNotice rows={list} />}
      {saved === 'billing' && (
        <SavedBanner message={`Billing ${billingEnabled ? 'enabled' : 'disabled'} for this application.`} />
      )}
      {saved === 'subject' && <SavedBanner message="Billing subject updated." />}
      {saved === 'dunning' && (
        <SavedBanner message={`Failed-payment recovery ${dunningEnabled ? 'enabled' : 'disabled'} for this application.`} />
      )}
      {saved && saved !== 'billing' && saved !== 'subject' && saved !== 'dunning' && (
        <SavedBanner
          message={`${PROVIDER_LABEL[saved as BillingProviderName] ?? saved} credentials saved. Encrypted at rest.`}
        />
      )}
      {webhook && (
        <SavedBanner
          params={['webhook']}
          message={`${PROVIDER_LABEL[webhook as BillingProviderName] ?? webhook} webhook configured automatically — no dashboard paste needed.`}
        />
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {ERR[error] ?? error}
        </p>
      )}

      {/* Master switch — gates the whole billing surface + the Billing tab group. */}
      <Card className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Billing</h2>
            <Badge tone={billingEnabled ? 'success' : 'neutral'} dot>
              {billingEnabled ? 'enabled' : 'disabled'}
            </Badge>
          </div>
          <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
            {billingEnabled
              ? 'Plans, checkout, subscriptions, coupons, credits, licenses and usage are live for this application.'
              : 'Billing is off. The public billing API returns 403 and the Plans / Coupons / Licenses / Usage tabs are hidden until you enable it.'}
          </p>
        </div>
        <form action={setBillingEnabled.bind(null, id, !billingEnabled)} className="shrink-0">
          {billingEnabled ? (
            <ConfirmButton
              confirm="Disable billing? The public billing API (checkout, subscriptions, plans, coupons, credits, licenses, usage) will immediately return 403 and the Billing tab group will be hidden. Existing subscriptions are not cancelled — you can re-enable any time."
              variant="danger"
            >
              Disable billing
            </ConfirmButton>
          ) : (
            <SubmitButton pendingLabel="Enabling…" className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60">Enable billing</SubmitButton>
          )}
        </form>
      </Card>

      {/* Failed-payment recovery (dunning) — opt-in per app. Only meaningful
          while billing is enabled; off by default. */}
      {billingEnabled && (
        <Card className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">Failed-payment recovery</h2>
              <Badge tone={dunningEnabled ? 'success' : 'neutral'} dot>
                {dunningEnabled ? 'on' : 'off'}
              </Badge>
            </div>
            <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
              {dunningEnabled
                ? 'When a subscription goes past due, ReliPay emails the customer reminders on day 0, 3 and 7, then cancels the subscription on day 14 if it’s still unpaid (and cancels it provider-side too). A successful payment in between closes the case.'
                : 'Off. A past-due subscription gets no reminder emails and is not auto-cancelled — the provider’s own retries still run. Turn this on to have ReliPay chase failed payments and auto-cancel after 14 days.'}
            </p>
          </div>
          <form action={setDunningEnabled.bind(null, id, !dunningEnabled)} className="shrink-0">
            {dunningEnabled ? (
              <ConfirmButton
                confirm="Turn off failed-payment recovery? New past-due subscriptions will get no reminder emails and won’t be auto-cancelled. Cases already in progress finish on their existing schedule."
                variant="danger"
              >
                Turn off
              </ConfirmButton>
            ) : (
              <SubmitButton pendingLabel="Enabling…" className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60">Turn on</SubmitButton>
            )}
          </form>
        </Card>
      )}

      {/* Billing subject — who a subscription bills + benefits by default. Only
          meaningful when organizations are enabled. */}
      {app.authConfig.organizationsEnabled === true && (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Who pays?</h2>
            <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
              Bill each end-user individually, or bill the organization they belong to.{' '}
              <strong>Organizations</strong> share a team pool (members share feature access +
              credits; the buyer is the owner/payer). Checkout can always override per call with{' '}
              <code className="text-xs">organizationId</code>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(['user', 'org'] as const).map((s) => {
              const current = (app.billingConfig.billingSubject ?? 'user') === s;
              return (
                <form key={s} action={setBillingSubject.bind(null, id, s)}>
                  {current ? (
                    <button
                      type="button"
                      disabled
                      className="rounded-md border px-3 py-1.5 text-sm cursor-default border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)]"
                    >
                      {s === 'user' ? 'Individual users' : 'Organizations'} ✓
                    </button>
                  ) : (
                    <SubmitButton
                      pendingLabel="Switching…"
                      className="rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
                    >
                      {s === 'user' ? 'Individual users' : 'Organizations'}
                    </SubmitButton>
                  )}
                </form>
              );
            })}
          </div>
        </Card>
      )}

      {/* Providers — configurable any time; only effective while billing is enabled. */}
      <div className={billingEnabled ? '' : 'opacity-60'}>
        <SectionHeader
          title="Billing providers"
          description={
            <>
              Configure any subset of {Object.values(PROVIDER_LABEL).join(' / ')}. End-users pick one
              at checkout, or the geo router picks based on their country (CF-IPCountry header). After
              payment, checkout returns to the <code className="text-xs">successUrl</code> /{' '}
              <code className="text-xs">cancelUrl</code> your app passes on each checkout call — set
              those to your production URLs (a localhost value sends users to localhost).
            </>
          }
        />
      </div>

      {/* Summary table */}
      <Table minWidth="min-w-[56rem]">
        <THead>
          <TR>
            <TH>Provider</TH>
            <TH>Status</TH>
            <TH>Mode</TH>
            <TH>Countries</TH>
            <TH align="right">Priority</TH>
            <TH>Webhook</TH>
            <TH align="right"> </TH>
          </TR>
        </THead>
        <TBody>
          {(['stripe', 'paypal', 'razorpay'] as BillingProviderName[]).map((p) => {
            const row = byProvider.get(p);
            return (
              <TR key={p} hover>
                <TD className="font-medium">{PROVIDER_LABEL[p]}</TD>
                <TD>
                  {!row ? (
                    <span className="text-xs text-[var(--color-muted-fg)]">not configured</span>
                  ) : row.enabled ? (
                    <Badge tone="success" dot>active</Badge>
                  ) : (
                    <Badge tone="neutral" dot>disabled</Badge>
                  )}
                </TD>
                <TD className="text-xs">
                  {!row ? (
                    <span className="text-[var(--color-muted-fg)]">—</span>
                  ) : row.mode === 'live' ? (
                    <Badge tone="warning" dot>live</Badge>
                  ) : (
                    <Badge tone="neutral">test</Badge>
                  )}
                </TD>
                <TD muted className="text-xs">
                  {!row ? '—' : row.countries.length === 0 ? 'all (global)' : row.countries.join(', ')}
                </TD>
                <TD align="right" muted className="text-xs">
                  {row ? row.priority : '—'}
                </TD>
                <TD className="text-xs">
                  {!row ? (
                    <span className="text-[var(--color-muted-fg)]">—</span>
                  ) : row.webhookConfigured ? (
                    <Badge tone="success" dot>configured</Badge>
                  ) : p === 'razorpay' ? (
                    // Razorpay has no webhook-create API — it's always a manual
                    // dashboard paste, so no Auto-configure. The "how" + the why
                    // live in the Edit modal; the tooltip hints it here.
                    <span title="Razorpay has no webhook API — set it up manually in Edit (no Auto-configure).">
                      <Badge tone="warning" dot>not set up</Badge>
                    </span>
                  ) : (
                    <form action={registerWebhook.bind(null, id, p)} className="inline">
                      <SubmitButton
                        pendingLabel="Configuring…"
                        className="rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 disabled:opacity-60"
                        title="Create the webhook via the provider API and store the secret automatically"
                      >
                        Auto-configure
                      </SubmitButton>
                    </form>
                  )}
                </TD>
                <TD align="right">
                  <div className="flex items-center justify-end gap-3">
                    <ProviderEditModal
                      provider={p}
                      existing={row}
                      applicationId={id}
                      webhookUrl={
                        p === 'stripe'
                          ? stripeWebhookUrl
                          : p === 'paypal'
                            ? paypalWebhookUrl
                            : razorpayWebhookUrl
                      }
                      error={edit === p ? error : undefined}
                    />
                    {row && (
                      <>
                        <form action={toggleEnabled.bind(null, id, p, !row.enabled)} className="inline">
                          <SubmitButton
                            pendingLabel={row.enabled ? 'Disabling…' : 'Enabling…'}
                            className="rounded text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 disabled:opacity-60"
                          >
                            {row.enabled ? 'Disable' : 'Enable'}
                          </SubmitButton>
                        </form>
                        <form action={removeProvider.bind(null, id, p)} className="inline">
                          <TypedConfirmButton
                            expected={PROVIDER_LABEL[p].toLowerCase()}
                            title={`Remove ${PROVIDER_LABEL[p]} credentials?`}
                            description={`Existing subscriptions keep running but no new checkouts can use ${PROVIDER_LABEL[p]}. You'll need to re-paste the API keys from the ${PROVIDER_LABEL[p]} dashboard to restore.`}
                            triggerLabel="Remove"
                            confirmLabel={`Remove ${PROVIDER_LABEL[p]}`}
                          />
                        </form>
                      </>
                    )}
                  </div>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>

      {/* Inbound provider webhook log — events ReliPay received from the providers. */}
      <section className="space-y-3">
        <SectionHeader
          title="Inbound webhook events"
          description="Events ReliPay received from your billing providers (subscription activated, payment captured, …). Newest first — distinct from your app's own outbound webhooks."
        />
        {webhookEvents.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No provider webhook events yet"
            description="They appear here once a provider posts to your webhook URL (use “Auto-configure webhook” above first)."
          />
        ) : (
          <Table minWidth="min-w-[48rem]">
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Provider</TH>
                <TH>Event</TH>
                <TH>Status</TH>
                <TH>Provider event id</TH>
              </TR>
            </THead>
            <TBody>
              {webhookEvents.map((e) => (
                <TR key={e.id} hover className="align-top">
                  <TD muted className="whitespace-nowrap text-xs">{formatDateTime(e.receivedAt)}</TD>
                  <TD className="text-xs">{PROVIDER_LABEL[e.provider as BillingProviderName] ?? e.provider}</TD>
                  <TD mono>{e.eventType}</TD>
                  <TD>
                    <Badge tone={WEBHOOK_STATUS_TONE[e.status]} dot>{e.status}</Badge>
                    {e.processingError && (
                      <span className="mt-1 block max-w-[16rem] truncate text-[11px] text-red-600 dark:text-red-400" title={e.processingError}>
                        {e.processingError}
                      </span>
                    )}
                  </TD>
                  <TD muted mono className="max-w-[12rem] truncate text-[11px]">{e.providerEventId}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--color-fg)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}

/**
 * Per-provider webhook setup metadata. Drives the WebhookSetup block so the
 * modal isn't a wall of inline event-name <code> tags. `autoConfigurable`
 * providers expose ReliPay's one-click register; Razorpay has no webhook-create
 * API, so it's a short manual paste.
 */
const WEBHOOK_META: Record<
  BillingProviderName,
  {
    autoConfigurable: boolean;
    dashboardPath: string;
    events: string[];
    /** What the operator pastes back into ReliPay after creating the webhook. */
    returnLabel: string;
  }
> = {
  stripe: {
    autoConfigurable: true,
    dashboardPath: 'Stripe Dashboard → Developers → Webhooks → Add endpoint',
    events: [
      'checkout.session.completed',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
    ],
    returnLabel: 'Copy the signing secret (whsec_…) Stripe shows, paste it below.',
  },
  paypal: {
    autoConfigurable: true,
    dashboardPath: 'PayPal Developer Dashboard → your App → Webhooks',
    events: [
      'BILLING.SUBSCRIPTION.ACTIVATED',
      'BILLING.SUBSCRIPTION.CANCELLED',
      'BILLING.SUBSCRIPTION.SUSPENDED',
      'BILLING.SUBSCRIPTION.EXPIRED',
      'PAYMENT.SALE.COMPLETED',
      'PAYMENT.SALE.DENIED',
    ],
    returnLabel: 'Copy the generated Webhook ID, paste it below.',
  },
  razorpay: {
    autoConfigurable: false,
    dashboardPath: 'Razorpay Dashboard → Settings → Webhooks → Add New Webhook',
    events: [
      'subscription.activated',
      'subscription.charged',
      'subscription.cancelled',
      'subscription.completed',
      'subscription.halted',
      'payment_link.paid',
    ],
    returnLabel: 'Set a secret on the webhook, then enter the SAME secret below.',
  },
};

/**
 * Webhook setup guidance for one provider. Replaces the old raw URL + inline
 * event-code dump with a numbered, copy-first flow. Pure server component —
 * the auto/manual split uses a native <details> so it needs no client JS.
 */
function WebhookSetup({
  provider,
  label,
  webhookUrl,
  configured,
}: {
  provider: BillingProviderName;
  label: string;
  webhookUrl: string | null;
  configured: boolean;
}): React.JSX.Element {
  const meta = WEBHOOK_META[provider];

  // No public base URL → no usable endpoint to paste. Surface the blocker.
  if (!webhookUrl) {
    return (
      <div className="rounded-lg border border-amber-300 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5">
        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
          Webhook endpoint unavailable
        </p>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300/90">
          <code className="font-mono">RELIPAY_URL</code> isn’t set on the panel deployment, so the{' '}
          {label} webhook URL can’t be built. Ask your admin to set it and redeploy, then return here.
        </p>
      </div>
    );
  }

  const manualSteps = (
    <ol className="space-y-2 text-xs text-[var(--color-muted-fg)]">
      <li className="flex gap-2">
        <StepDot n={1} />
        <span>
          Open <span className="font-medium text-[var(--color-fg)]">{meta.dashboardPath}</span>.
        </span>
      </li>
      <li className="flex gap-2">
        <StepDot n={2} />
        <div className="min-w-0 flex-1 space-y-1">
          <span>Paste this as the endpoint / callback URL:</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono" title={webhookUrl}>
              {webhookUrl}
            </code>
            <CopyButton value={webhookUrl} label="Copy" />
          </div>
        </div>
      </li>
      <li className="flex gap-2">
        <StepDot n={3} />
        <span>{meta.returnLabel}</span>
      </li>
      <li className="flex gap-2">
        <StepDot n={4} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <span>Subscribe to these events:</span>
          <div className="flex flex-wrap gap-1">
            {meta.events.map((e) => (
              <code
                key={e}
                className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-fg)]"
              >
                {e}
              </code>
            ))}
          </div>
        </div>
      </li>
    </ol>
  );

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--color-fg)]">Webhook</span>
        {configured ? (
          <Badge tone="success" dot>configured</Badge>
        ) : (
          <Badge tone="warning" dot>not set up</Badge>
        )}
      </div>
      <p className="text-xs text-[var(--color-muted-fg)]">
        {label} tells ReliPay when payments succeed or subscriptions change. Without a webhook,
        checkouts complete but nothing is fulfilled.
      </p>

      {meta.autoConfigurable ? (
        <>
          <div className="rounded-md border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 px-2.5 py-2">
            <p className="text-xs font-medium text-[var(--color-fg)]">Recommended — one click</p>
            <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
              Save your API keys below, then hit <span className="font-medium">Auto-configure</span>{' '}
              in the providers table. ReliPay creates the webhook and stores its secret for you — no
              dashboard steps, leave the secret field blank.
            </p>
          </div>
          <details className="group">
            <summary className="cursor-pointer list-none text-xs font-medium text-[var(--color-primary)] hover:underline">
              Prefer to set it up by hand?
            </summary>
            <div className="mt-2 border-t border-[var(--color-border)] pt-2.5">{manualSteps}</div>
          </details>
        </>
      ) : (
        <>
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-2">
            <p className="text-xs font-medium text-[var(--color-fg)]">Manual setup only</p>
            <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
              Unlike Stripe and PayPal, Razorpay has no API to create webhooks — so there’s no
              <span className="font-medium"> Auto-configure</span> button for it. It’s a quick
              one-time setup in the Razorpay dashboard:
            </p>
          </div>
          {manualSteps}
        </>
      )}
    </div>
  );
}

function StepDot({ n }: { n: number }): React.JSX.Element {
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[10px] font-semibold text-[var(--color-primary)]">
      {n}
    </span>
  );
}

/**
 * Per-provider configure / rotate Modal. Same chrome (Modal trigger button +
 * label + hint Field rows) matches the rest of the panel. Trigger label
 * flips between "Configure" and "Edit" based on whether creds exist.
 */
function ProviderEditModal({
  provider,
  existing,
  applicationId,
  webhookUrl,
  error,
}: {
  provider: BillingProviderName;
  existing: BillingCredentialRow | undefined;
  applicationId: string;
  webhookUrl: string | null;
  error: string | undefined;
}): React.JSX.Element {
  const label =
    provider === 'stripe' ? 'Stripe' : provider === 'paypal' ? 'PayPal' : 'Razorpay';
  const action =
    provider === 'stripe'
      ? upsertStripe.bind(null, applicationId)
      : provider === 'paypal'
      ? upsertPaypal.bind(null, applicationId)
      : upsertRazorpay.bind(null, applicationId);

  return (
    <Modal
      modalKey={`edit_${provider}`}
      title={`${existing ? 'Edit' : 'Configure'} ${label}`}
      description={
        existing
          ? 'Rotate keys or change routing. Leaving a secret blank keeps the existing value.'
          : `Connect your ${label} account. Credentials are AES-256-GCM encrypted at rest; never returned in any API response.`
      }
      trigger={existing ? 'Edit' : 'Configure'}
      triggerClassName="cursor-pointer rounded text-xs font-medium text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50"
    >
      <form action={action} className="space-y-3">
        {error && (
          <p role="alert" className="rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERR[error] ?? error}
          </p>
        )}

        {provider === 'stripe' && (
          <>
            <Field label="API key" hint="From Stripe → Developers → API keys.">
              <input type="password" name="apiKey" required autoComplete="off" placeholder="sk_test_… or sk_live_…"
                className={`${inputCls} font-mono`} />
            </Field>
            <Field label="Webhook signing secret" hint="Leave blank to auto-configure (recommended). Only fill this if you set the webhook up by hand.">
              <input type="password" name="webhookSecret" autoComplete="off" placeholder="whsec_… (or leave blank)"
                className={`${inputCls} font-mono`} />
            </Field>
          </>
        )}

        {provider === 'paypal' && (
          <>
            <Field label="Client ID" hint="From PayPal Developer → Apps & Credentials.">
              <input type="text" name="clientId" required autoComplete="off"
                className={`${inputCls} font-mono`} />
            </Field>
            <Field label="Client secret">
              <input type="password" name="clientSecret" required autoComplete="off"
                className={`${inputCls} font-mono`} />
            </Field>
            <Field label="Webhook ID" hint="Leave blank to auto-configure (recommended). Only fill this if you set the webhook up by hand.">
              <input type="text" name="webhookId" autoComplete="off" placeholder="(or leave blank)"
                className={`${inputCls} font-mono`} />
            </Field>
          </>
        )}

        {provider === 'razorpay' && (
          <>
            <Field label="Key ID" hint="From Razorpay Dashboard → Settings → API Keys.">
              <input type="text" name="keyId" required autoComplete="off" placeholder="rzp_test_… or rzp_live_…"
                className={`${inputCls} font-mono`} />
            </Field>
            <Field label="Key secret">
              <input type="password" name="keySecret" required autoComplete="off"
                className={`${inputCls} font-mono`} />
            </Field>
            <Field label="Webhook secret" hint="The same secret you set on the webhook in Razorpay — see the Webhook steps below.">
              <input type="password" name="webhookSecret" required autoComplete="off"
                className={`${inputCls} font-mono`} />
            </Field>
          </>
        )}

        {/* Webhook setup — numbered, copy-first; auto-configure where supported. */}
        <WebhookSetup
          provider={provider}
          label={label}
          webhookUrl={webhookUrl}
          configured={existing?.webhookConfigured ?? false}
        />

        <div className="grid grid-cols-3 gap-3 pt-2 border-t border-[var(--color-border)]">
          <Field label="Mode" hint="live = real charges; test = sandbox, no real money. Stay in test until you're ready. Auto-detected from the key prefix.">
            <select name="mode" defaultValue={existing?.mode ?? 'test'} className={inputCls}>
              <option value="test">Test</option>
              <option value="live">Live</option>
            </select>
          </Field>
          <BillingModeAutodetect />
          <Field label="Countries" hint="Empty = global">
            <input type="text" name="countries" defaultValue={existing?.countries.join(', ') ?? ''}
              placeholder="US, CA" className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Priority" hint="Lower = first">
            <input type="number" name="priority" min={0} max={1000} step={1}
              defaultValue={existing?.priority ?? 100} className={`${inputCls} font-mono`} />
          </Field>
        </div>

        <SubmitButton pendingLabel="Saving…">{existing ? 'Save changes' : 'Save credentials'}</SubmitButton>
      </form>
    </Modal>
  );
}
