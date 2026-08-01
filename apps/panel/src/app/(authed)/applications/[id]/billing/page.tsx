import * as React from 'react';
import { redirect } from 'next/navigation';
import {
  api,
  PanelApiError,
  type ApplicationRow,
  type BillingCredentialRow,
  type BillingProviderDescriptor,
  type BillingProviderName,
} from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { formatDateTime } from '@/lib/date';
import { publicHttpUrl } from '@/lib/public-url';
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

/**
 * The ONE generic credentials action (P4) — replaces the per-provider
 * upsertStripe/upsertPaypal/upsertRazorpay trio. `fieldKeys` is bound from
 * the provider's discovery `credentialFields`, so the collected `data` shape
 * always matches what the module's registry-derived PUT route expects. The
 * API re-validates everything (pattern prefixes, required fields) and raises
 * BILLING_CREDENTIALS_INVALID, surfaced via the ?error banner.
 */
async function saveProviderCredentials(
  applicationId: string,
  provider: BillingProviderName,
  fieldKeys: string[],
  formData: FormData,
): Promise<void> {
  'use server';
  const data: Record<string, string> = {};
  for (const key of fieldKeys) {
    data[key] = String(formData.get(key) ?? '').trim();
  }
  const countries = parseCountries(formData.get('countries'));
  const priority = parsePriority(formData.get('priority'));
  const mode = parseMode(formData.get('mode'));
  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/${encodeURIComponent(provider)}`,
      body: { data, countries, priority, mode },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(
        `/applications/${applicationId}/billing?error=${encodeURIComponent(err.code)}&edit=${encodeURIComponent(provider)}`,
      );
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/billing?saved=${encodeURIComponent(provider)}`);
}

async function toggleEnabled(
  applicationId: string,
  provider: BillingProviderName,
  enabled: boolean,
): Promise<void> {
  'use server';
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/${encodeURIComponent(provider)}`,
    body: { enabled },
  });
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
  redirect(`/applications/${applicationId}/billing?saved=subject`);
}

async function removeProvider(
  applicationId: string,
  provider: BillingProviderName,
): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/${encodeURIComponent(provider)}`,
  });
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
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/${encodeURIComponent(provider)}/register-webhook`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/billing?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
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

/**
 * Built-in fallback labels (P4): the discovery endpoint's `label` is the
 * source of truth; this map only covers banner lookups for names that fall
 * outside the fetched registry (e.g. a stale `?saved=` param). Unknown names
 * degrade to a capitalized spelling.
 */
const FALLBACK_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  razorpay: 'Razorpay',
};

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

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

  const [app, discovery, webhookEvents] = await Promise.all([
    api<ApplicationRow>({ method: 'GET', path: `/api/v1/tenant/applications/${encodeURIComponent(id)}` }),
    // P4 discovery: every registered provider module + this app's configured
    // status in one call — drives the provider table, labels, and the
    // autogenerated credential forms.
    api<{ providers: BillingProviderDescriptor[] }>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/billing/providers`,
    }),
    api<WebhookEventRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/billing-credentials/webhook-events?limit=25`,
    }).catch(() => [] as WebhookEventRow[]),
  ]);

  const providers = discovery.providers;
  // Configured-credential rows, reconstructed from the discovery statuses —
  // same shape `GET /billing-credentials` returns (BillingModeNotice reads it).
  const list: BillingCredentialRow[] = providers
    .filter((d) => d.status !== null)
    .map((d) => ({ provider: d.name, configured: true, ...d.status! }));
  const labelOf = (name: string): string =>
    providers.find((d) => d.name === name)?.label ?? FALLBACK_LABEL[name] ?? capitalize(name);
  const billingEnabled = app.billingConfig.enabled;
  const dunningEnabled = app.billingConfig.dunningEnabled ?? false;

  // This URL is PASTED INTO the provider dashboard, so it must be the PUBLIC
  // API origin the provider can reach — not the in-cluster REKEY_URL
  // (e.g. `http://api:3030`), which would show an unreachable `api:3030`-style
  // host. Prefer NEXT_PUBLIC_API_URL (the public origin); fall back to
  // REKEY_URL only for local dev where they're the same — and only after
  // publicHttpUrl() confirms it looks public (dotted host or localhost), so an
  // in-cluster value never leaks into the HTML. When neither passes, apiBase is
  // null and the row renders a "configure NEXT_PUBLIC_API_URL" warning so the
  // operator catches it before pasting (Stripe silently rejects relative/bad
  // hosts and the webhook then fails forever — UX-AUDIT MEDIUM #24).
  const apiBase =
    publicHttpUrl(process.env.NEXT_PUBLIC_API_URL) ?? publicHttpUrl(process.env.REKEY_URL);
  // Module-name-driven (P4): the shared webhook pipeline route is
  // /billing/webhook/:provider/:slug for every registered module.
  const webhookUrlFor = (name: string): string | null =>
    apiBase ? `${apiBase}/api/v1/billing/webhook/${encodeURIComponent(name)}/${app.slug}` : null;

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
          message={`${labelOf(saved)} credentials saved. Encrypted at rest.`}
        />
      )}
      {webhook && (
        <SavedBanner
          params={['webhook']}
          message={`${labelOf(webhook)} webhook configured automatically — no dashboard paste needed.`}
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
                ? 'When a subscription goes past due, Rekey emails the customer reminders on day 0, 3 and 7, then cancels the subscription on day 14 if it’s still unpaid (and cancels it provider-side too). A successful payment in between closes the case.'
                : 'Off. A past-due subscription gets no reminder emails and is not auto-cancelled — the provider’s own retries still run. Turn this on to have Rekey chase failed payments and auto-cancel after 14 days.'}
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
                      className="rounded-md border px-3 py-1.5 text-sm cursor-default border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)] text-[var(--color-primary)]"
                    >
                      {s === 'user' ? 'Individual users' : 'Organizations'} ✓
                    </button>
                  ) : (
                    <SubmitButton
                      pendingLabel="Switching…"
                      className="rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
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
              Configure any subset of {providers.map((d) => d.label).join(' / ')}. End-users pick one
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
          {providers.map((d) => {
            const p = d.name;
            const row = d.status;
            return (
              <TR key={p} hover>
                <TD className="font-medium">{d.label}</TD>
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
                  ) : !d.capabilities.autoWebhookRegister ? (
                    // Capability-driven (P4): no webhook-create API (Razorpay)
                    // → always a manual dashboard paste, so no Auto-configure.
                    // The "how" + the why live in the Edit modal; the tooltip
                    // hints it here.
                    <span title={`${d.label} has no webhook API — set it up manually in Edit (no Auto-configure).`}>
                      <Badge tone="warning" dot>not set up</Badge>
                    </span>
                  ) : (
                    <form action={registerWebhook.bind(null, id, p)} className="inline">
                      <SubmitButton
                        pendingLabel="Configuring…"
                        className="rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
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
                      descriptor={d}
                      applicationId={id}
                      webhookUrl={webhookUrlFor(p)}
                      error={edit === p ? error : undefined}
                    />
                    {row && (
                      <>
                        <form action={toggleEnabled.bind(null, id, p, !row.enabled)} className="inline">
                          <SubmitButton
                            pendingLabel={row.enabled ? 'Disabling…' : 'Enabling…'}
                            className="rounded text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
                          >
                            {row.enabled ? 'Disable' : 'Enable'}
                          </SubmitButton>
                        </form>
                        <form action={removeProvider.bind(null, id, p)} className="inline">
                          <TypedConfirmButton
                            expected={d.label.toLowerCase()}
                            title={`Remove ${d.label} credentials?`}
                            description={`Existing subscriptions keep running but no new checkouts can use ${d.label}. You'll need to re-paste the API keys from the ${d.label} dashboard to restore.`}
                            triggerLabel="Remove"
                            confirmLabel={`Remove ${d.label}`}
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

      {/* Inbound provider webhook log — events Rekey received from the providers. */}
      <section className="space-y-3">
        <SectionHeader
          title="Inbound webhook events"
          description="Events Rekey received from your billing providers (subscription activated, payment captured, …). Newest first — distinct from your app's own outbound webhooks."
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
                  <TD className="text-xs">{labelOf(e.provider)}</TD>
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
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--color-fg)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}

interface WebhookMeta {
  dashboardPath: string;
  events: string[];
  /** What the operator pastes back into Rekey after creating the webhook. */
  returnLabel: string;
  /** Intro copy for manual-only providers (capabilities.autoWebhookRegister: false). */
  manualIntro?: string;
}

/**
 * Per-provider webhook setup COPY for the built-in three — dashboard click
 * paths and event lists live in the panel, not the registry (they're prose,
 * not contract). Whether a provider is auto-configurable comes from the
 * discovery `capabilities.autoWebhookRegister`, and unknown providers fall
 * back to a generic docsUrl-driven recipe (`webhookMetaFor`).
 */
const WEBHOOK_META: Record<string, WebhookMeta> = {
  stripe: {
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
    manualIntro:
      'Unlike Stripe and PayPal, Razorpay has no API to create webhooks — so there’s no Auto-configure button for it. It’s a quick one-time setup in the Razorpay dashboard:',
  },
};

/** Webhook copy for a provider — panel-curated where we have it, docsUrl-generic otherwise. */
function webhookMetaFor(d: BillingProviderDescriptor): WebhookMeta {
  return (
    WEBHOOK_META[d.name] ?? {
      dashboardPath: `the ${d.label} dashboard's webhook settings (see ${d.docsUrl})`,
      events: [],
      returnLabel: `Paste the webhook secret / id ${d.label} gives you into the field above.`,
      manualIntro: `${d.label} has no API to create webhooks — so there’s no Auto-configure button for it. It’s a quick one-time setup in the ${d.label} dashboard:`,
    }
  );
}

/**
 * Webhook setup guidance for one provider. Replaces the old raw URL + inline
 * event-code dump with a numbered, copy-first flow. Pure server component —
 * the auto/manual split uses a native <details> so it needs no client JS.
 */
function WebhookSetup({
  descriptor,
  webhookUrl,
  configured,
}: {
  descriptor: BillingProviderDescriptor;
  webhookUrl: string | null;
  configured: boolean;
}): React.JSX.Element {
  const label = descriptor.label;
  const meta = webhookMetaFor(descriptor);

  // No public base URL → no usable endpoint to paste. Surface the blocker.
  if (!webhookUrl) {
    return (
      <div className="rounded-lg border border-amber-300 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5">
        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
          Webhook endpoint unavailable
        </p>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300/90">
          <code className="font-mono">NEXT_PUBLIC_API_URL</code> (the public API origin) isn’t set on
          the panel deployment, so the {label} webhook URL can’t be built. Ask your admin to set it to
          your public API origin (e.g. <code className="font-mono">https://api.yourdomain.com</code>)
          and redeploy, then return here.
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
      {meta.events.length > 0 && (
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
      )}
    </ol>
  );

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-muted)_40%,transparent)] p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--color-fg)]">Webhook</span>
        {configured ? (
          <Badge tone="success" dot>configured</Badge>
        ) : (
          <Badge tone="warning" dot>not set up</Badge>
        )}
      </div>
      <p className="text-xs text-[var(--color-muted-fg)]">
        {label} tells Rekey when payments succeed or subscriptions change. Without a webhook,
        checkouts complete but nothing is fulfilled.
      </p>

      {descriptor.capabilities.autoWebhookRegister ? (
        <>
          <div className="rounded-md border border-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)] px-2.5 py-2">
            <p className="text-xs font-medium text-[var(--color-fg)]">Recommended — one click</p>
            <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
              Save your API keys below, then hit <span className="font-medium">Auto-configure</span>{' '}
              in the providers table. Rekey creates the webhook and stores its secret for you — no
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
              {meta.manualIntro ??
                `${label} has no API to create webhooks — set it up once in the ${label} dashboard:`}
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
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-[10px] font-semibold text-[var(--color-primary)]">
      {n}
    </span>
  );
}

/**
 * Per-provider configure / rotate Modal. Same chrome (Modal trigger button +
 * label + hint Field rows) matches the rest of the panel. Trigger label
 * flips between "Configure" and "Edit" based on whether creds exist.
 *
 * Fully discovery-driven (P4): the credential inputs render from the
 * module's `credentialFields` — secret fields become password inputs, the
 * field `help` (or `pattern.message`) becomes the hint — and the submit
 * action is the ONE generic `saveProviderCredentials`.
 */
function ProviderEditModal({
  descriptor,
  applicationId,
  webhookUrl,
  error,
}: {
  descriptor: BillingProviderDescriptor;
  applicationId: string;
  webhookUrl: string | null;
  error: string | undefined;
}): React.JSX.Element {
  const { name: provider, label, credentialFields } = descriptor;
  const existing = descriptor.status;
  const action = saveProviderCredentials.bind(
    null,
    applicationId,
    provider,
    credentialFields.map((f) => f.key),
  );

  return (
    <Modal
      size="lg"
      modalKey={`edit_${provider}`}
      title={`${existing ? 'Edit' : 'Configure'} ${label}`}
      description={
        existing
          ? 'Rotate keys or change routing. Leaving a secret blank keeps the existing value.'
          : `Connect your ${label} account. Credentials are AES-256-GCM encrypted at rest; never returned in any API response.`
      }
      trigger={existing ? 'Edit' : 'Configure'}
      triggerClassName="cursor-pointer rounded text-xs font-medium text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
    >
      <form action={action} className="space-y-3">
        {error && (
          <p role="alert" className="rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERR[error] ?? error}
          </p>
        )}

        {credentialFields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.help ?? f.pattern?.message}>
            <input
              type={f.secret ? 'password' : 'text'}
              name={f.key}
              required={!f.optional}
              autoComplete="off"
              {...(f.placeholder !== undefined && { placeholder: f.placeholder })}
              className={`${inputCls} font-mono`}
            />
          </Field>
        ))}

        {/* Webhook setup — numbered, copy-first; auto-configure where supported. */}
        <WebhookSetup
          descriptor={descriptor}
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
          <BillingModeAutodetect names={credentialFields.map((f) => f.key)} />
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
