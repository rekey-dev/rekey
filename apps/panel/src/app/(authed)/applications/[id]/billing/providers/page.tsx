import * as React from 'react';
import { readErrorFlash, getApplication, type BillingProviderDescriptor } from '@/lib/api';
import { ApiErrorText } from '@/components/api-error';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { BillingModeNotice } from '@/components/BillingModeBanner';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { registerWebhook, removeProvider, toggleProviderEnabled } from '../actions';
import { ProviderEditModal } from '../provider-dialog';
import { UnbuyablePlansNotice } from '../notices';
import {
  BILLING_ERR,
  credentialRows,
  getBillingProviders,
  getPlans,
  isInboundOnly,
  providerLabel,
  soldExternally,
  unbuyablePlans,
  webhookUrlFor,
} from '../shared';

const linkButtonCls =
  'rounded text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60';

export default async function BillingProvidersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix, left by `errorQuery` in a short-lived
  // httpOnly cookie rather than the URL, which anyone can compose.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const saved = typeof sp.saved === 'string' ? sp.saved : undefined;
  const edit = typeof sp.edit === 'string' ? sp.edit : undefined;
  const webhook = typeof sp.webhook === 'string' ? sp.webhook : undefined;

  const [app, providers, planPage] = await Promise.all([
    getApplication(id),
    getBillingProviders(id),
    getPlans(id),
  ]);
  const billingEnabled = app.billingConfig.enabled;
  const blocked = unbuyablePlans(planPage?.items ?? []);
  const checkoutProviders = providers.filter((d) => !isInboundOnly(d));
  const inboundProviders = providers.filter(isInboundOnly);
  const connected = providers.filter((d) => d.status !== null).length;

  return (
    <div className="space-y-5">
      {billingEnabled && <BillingModeNotice rows={credentialRows(providers)} />}
      {!billingEnabled && (
        <Banner tone="info">
          Billing is off, so these providers take no payments yet. You can connect them now and turn
          billing on from Status when you are ready.
        </Banner>
      )}
      <UnbuyablePlansNotice
        applicationId={id}
        plans={blocked}
        soldExternally={soldExternally(blocked)}
        checkoutProviderLabels={checkoutProviders.map((d) => d.label)}
        compact
      />
      {saved && (
        <SavedBanner message={`${providerLabel(providers, saved)} credentials saved. Encrypted at rest.`} />
      )}
      {webhook && (
        <SavedBanner
          params={['webhook']}
          message={`${providerLabel(providers, webhook)} webhook configured automatically. Nothing to paste in the provider dashboard.`}
        />
      )}
      {/* `?edit=<provider>` reopens that provider's dialog, which shows the
          error itself. Showing it here too would say it twice. */}
      {error && !edit && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={BILLING_ERR} fallback={error} />
        </Banner>
      )}

      <section className="space-y-3" aria-labelledby="providers-heading">
        <SectionHeader
          title={<span id="providers-heading">Payment providers</span>}
          count={`${connected} of ${providers.length} configured`}
          description={
            <>
              Configure any of {checkoutProviders.map((d) => d.label).join(', ')}. Buyers pick one at
              checkout, or Rekey picks by their country and your priority order. After payment the
              buyer goes to the <code className="text-xs">successUrl</code> or{' '}
              <code className="text-xs">cancelUrl</code> your app sends with each checkout, so use
              production URLs there.
              {inboundProviders.length > 0 && (
                <>
                  {' '}
                  {inboundProviders.map((d) => d.label).join(', ')} hosts no checkout: your own
                  billing system posts signed events, and Rekey starts, renews and cancels
                  subscriptions from them.
                </>
              )}
            </>
          }
        />

        <Table minWidth="min-w-[56rem]">
          <THead>
            <TR>
              <TH>Provider</TH>
              <TH>Status</TH>
              <TH>Mode</TH>
              <TH>Countries</TH>
              <TH align="right">Priority</TH>
              <TH>Webhook</TH>
              <TH align="right">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {providers.map((d) => (
              <ProviderRow
                key={d.name}
                descriptor={d}
                applicationId={id}
                webhookUrl={webhookUrlFor(d, app.slug)}
                error={edit === d.name ? error : undefined}
                errorDetail={errorDetail}
                errorFix={errorFix}
              />
            ))}
          </TBody>
        </Table>
      </section>
    </div>
  );
}

function ProviderRow({
  descriptor: d,
  applicationId,
  webhookUrl,
  error,
  errorDetail,
  errorFix,
}: {
  descriptor: BillingProviderDescriptor;
  applicationId: string;
  webhookUrl: string | null;
  error: string | undefined;
  errorDetail: string | undefined;
  errorFix: string | undefined;
}): React.JSX.Element {
  const row = d.status;
  const inbound = isInboundOnly(d);
  const dash = <span className="text-[var(--color-muted-fg)]">—</span>;
  return (
    <TR hover>
      <TD className="font-medium">
        {d.label}
        {inbound && (
          <span className="mt-0.5 block text-[11px] font-normal text-[var(--color-muted-fg)]">
            Inbound events only, no checkout
          </span>
        )}
      </TD>
      <TD>
        {!row ? (
          <span className="text-xs text-[var(--color-muted-fg)]">Not configured</span>
        ) : row.enabled ? (
          <Badge tone="success" dot>active</Badge>
        ) : (
          <Badge tone="neutral" dot>disabled</Badge>
        )}
      </TD>
      <TD className="text-xs">
        {!row ? dash : row.mode === 'live' ? <Badge tone="warning" dot>live</Badge> : <Badge tone="neutral">test</Badge>}
      </TD>
      <TD muted className="text-xs">
        {!row || inbound ? '—' : row.countries.length === 0 ? 'All countries' : row.countries.join(', ')}
      </TD>
      <TD align="right" muted className="text-xs tabular-nums">
        {row && !inbound ? row.priority : '—'}
      </TD>
      <TD className="text-xs">
        {!row ? (
          dash
        ) : row.webhookConfigured ? (
          <Badge tone="success" dot>configured</Badge>
        ) : !d.capabilities.autoWebhookRegister ? (
          <span
            title={
              inbound
                ? 'Save a signing secret in Edit; your billing system signs its events with it.'
                : `${d.label} has no webhook API. Follow the steps in Edit to set it up by hand.`
            }
          >
            <Badge tone="warning" dot>not set up</Badge>
          </span>
        ) : (
          <ActionForm action={registerWebhook.bind(null, applicationId, d.name)} className="inline">
            <SubmitButton
              pendingLabel="Configuring…"
              className={`${linkButtonCls} text-[var(--color-primary)] hover:underline`}
              title="Create the webhook through the provider's API and store its secret"
            >
              Auto-configure
            </SubmitButton>
          </ActionForm>
        )}
      </TD>
      <TD align="right">
        <div className="flex items-center justify-end gap-3">
          <ProviderEditModal
            descriptor={d}
            applicationId={applicationId}
            webhookUrl={webhookUrl}
            error={error}
            errorDetail={errorDetail}
            errorFix={errorFix}
          />
          {row && (
            <>
              <ActionForm action={toggleProviderEnabled.bind(null, applicationId, d.name, !row.enabled)} className="inline">
                <SubmitButton
                  pendingLabel={row.enabled ? 'Disabling…' : 'Enabling…'}
                  className={`${linkButtonCls} font-normal text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline`}
                >
                  {row.enabled ? 'Disable' : 'Enable'}
                </SubmitButton>
              </ActionForm>
              <ActionForm action={removeProvider.bind(null, applicationId, d.name)} className="inline">
                <TypedConfirmButton
                  expected={d.label.toLowerCase()}
                  title={`Remove ${d.label} credentials?`}
                  description={
                    inbound
                      ? 'Existing subscriptions keep running, but events from your billing system are refused (503) until a signing secret is saved again.'
                      : `Existing subscriptions keep running but no new checkouts can use ${d.label}. You'll need to re-paste the API keys from the ${d.label} dashboard to restore.`
                  }
                  triggerLabel="Remove"
                  confirmLabel={`Remove ${d.label}`}
                />
              </ActionForm>
            </>
          )}
        </div>
      </TD>
    </TR>
  );
}
