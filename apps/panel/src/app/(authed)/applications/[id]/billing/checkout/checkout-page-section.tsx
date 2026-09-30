/**
 * Billing setup → Checkout page tab: which page buyers pay on, per payment mode, what
 * happens when the Rekey page cannot take a checkout, the readiness checks as
 * Test and Live columns, and how the page has been doing (spec 8.8.1, 8.8.3,
 * 8.8.5).
 *
 * Switching a mode to the Rekey page runs that mode's checks on the API and is
 * refused on any FAIL, which comes back through the tab's error banner.
 * Switching back to the provider's page is never refused.
 */

import * as React from 'react';
import { redirect } from 'next/navigation';
import type { CheckoutReadiness, CheckoutReadinessCheck, CheckoutStatusPanel } from '@rekey.dev/shared-types';
import { api, errorQuery, PanelApiError, unlessBusy } from '@/lib/api';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { StickyFormFooter } from '@/components/StickyFormFooter';
import { Card, SectionHeader } from '@/components/Card';
import { Badge, type BadgeTone } from '@/components/Badge';
import { formatDateTime } from '@/lib/date';
import { EmptyState } from '@/components/EmptyState';
import { savedStateKey } from '@/lib/saved-state-key';

type Mode = 'test' | 'live';
type PageSetting = 'REDIRECT' | 'EMBEDDED';
type FailureMode = 'FALLBACK_TO_REDIRECT' | 'REFUSE';

const CHECK_LABEL: Record<CheckoutReadinessCheck['id'], string> = {
  portal: 'Portal reachable',
  provider: 'Provider supports the page',
  webhook: 'Webhook registered and delivering',
  plans: 'Plans ready in this mode',
  return_urls: 'Return URL origin registered',
  browser_credential: 'Browser credential',
  branding: 'Branding',
  csp_reports: 'CSP reports',
};

const STATUS_TONE: Record<CheckoutReadinessCheck['status'], BadgeTone> = {
  PASS: 'success',
  WARN: 'warning',
  FAIL: 'danger',
  'N/A': 'neutral',
};

function checkoutPath(applicationId: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/checkout`;
}

async function patchCheckout(applicationId: string, body: Record<string, string>, saved: string): Promise<void> {
  try {
    await api({ method: 'PATCH', path: checkoutPath(applicationId), body });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/billing/checkout?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/billing/checkout?saved=${saved}`);
}

async function setPage(applicationId: string, paymentMode: Mode, checkoutMode: PageSetting): Promise<void> {
  'use server';
  await patchCheckout(applicationId, { paymentMode, checkoutMode }, 'checkout');
}

async function setFailureMode(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const value = String(formData.get('checkoutFailureMode') ?? '');
  const checkoutFailureMode: FailureMode = value === 'REFUSE' ? 'REFUSE' : 'FALLBACK_TO_REDIRECT';
  await patchCheckout(applicationId, { checkoutFailureMode }, 'checkout');
}

async function runChecks(applicationId: string): Promise<void> {
  'use server';
  await api({ method: 'GET', path: `${checkoutPath(applicationId)}/readiness` });
  redirect(`/applications/${applicationId}/billing/checkout?saved=checkout_checks`);
}

function ModeRow({
  applicationId,
  mode,
  setting,
}: {
  applicationId: string;
  mode: Mode;
  setting: PageSetting;
}): React.JSX.Element {
  const embedded = setting === 'EMBEDDED';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <p className="text-sm font-medium text-[var(--color-fg)]">{mode === 'live' ? 'Live' : 'Test'} checkouts</p>
        <p className="text-xs text-[var(--color-muted-fg)]">
          {embedded ? 'Rekey page (beta)' : "Provider's page (default)"}
        </p>
      </div>
      <ActionForm action={setPage.bind(null, applicationId, mode, embedded ? 'REDIRECT' : 'EMBEDDED')}>
        <SubmitButton pendingLabel={embedded ? 'Switching…' : 'Running checks…'}>
          {embedded ? "Use the provider's page" : 'Use the Rekey page'}
        </SubmitButton>
      </ActionForm>
    </div>
  );
}

function Column({ title, checks }: { title: string; checks: CheckoutReadinessCheck[] }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-fg)]">{title}</h3>
      <ul className="space-y-2">
        {checks.map((c, i) => (
          <li key={`${c.id}-${c.provider ?? 'app'}-${i}`} className="rounded-md border border-[var(--color-border)] px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-[var(--color-fg)]">
                {CHECK_LABEL[c.id]}
                {c.provider ? <span className="font-normal text-[var(--color-muted-fg)]"> · {c.provider}</span> : null}
              </span>
              <Badge tone={STATUS_TONE[c.status]} dot>
                {c.status}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-[var(--color-muted-fg)]">{c.message}</p>
            {c.fix && c.status !== 'PASS' && <p className="mt-1 text-xs text-[var(--color-fg)]">Fix: {c.fix}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export async function CheckoutPageSection({ applicationId }: { applicationId: string }): Promise<React.JSX.Element> {
  const [status, readiness] = await Promise.all([
    api<CheckoutStatusPanel>({ method: 'GET', path: `${checkoutPath(applicationId)}/status` }).catch(unlessBusy(() => null)),
    api<CheckoutReadiness>({ method: 'GET', path: `${checkoutPath(applicationId)}/readiness?cached=true` }).catch(
      unlessBusy(() => null),
    ),
  ]);
  if (status === null) {
    return (
      <EmptyState
        variant="inline"
        title="Checkout page settings are not available"
        description="The API did not return this Application's checkout settings. Reload the page, and check the API logs if it keeps happening."
      />
    );
  }
  const failure = status.settings.checkoutFailureMode;

  return (
    <div className="space-y-5">
      <section className="space-y-3" aria-labelledby="checkout-where-heading">
        <SectionHeader
          title={
            <span id="checkout-where-heading" className="flex items-center gap-2">
              Where buyers pay <Badge tone="info">beta</Badge>
            </span>
          }
          description="The provider's own page, or the Rekey page with your name and logo and the provider's payment buttons. Test and live checkouts are set separately; a checkout follows the mode of the provider credentials it runs on."
        />
        <Card className="space-y-4">
          <div className="divide-y divide-[var(--color-border)]">
            <ModeRow applicationId={applicationId} mode="test" setting={status.settings.checkoutModeTest} />
            <ModeRow applicationId={applicationId} mode="live" setting={status.settings.checkoutModeLive} />
          </div>

          <ActionForm
            key={savedStateKey(failure)}
            action={setFailureMode.bind(null, applicationId)}
            className="space-y-3 border-t border-[var(--color-border)] pt-4"
          >
            <fieldset>
              <legend className="text-sm font-medium text-[var(--color-fg)]">If the Rekey page cannot be used for a checkout</legend>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="radio" name="checkoutFailureMode" value="FALLBACK_TO_REDIRECT" defaultChecked={failure === 'FALLBACK_TO_REDIRECT'} />
                Fall back to the provider&apos;s page (default)
              </label>
              <label className="mt-1 flex items-center gap-2 text-sm">
                <input type="radio" name="checkoutFailureMode" value="REFUSE" defaultChecked={failure === 'REFUSE'} />
                Refuse the checkout
              </label>
            </fieldset>
            <StickyFormFooter />
          </ActionForm>
        </Card>
      </section>

      <section className="space-y-3" aria-labelledby="checkout-readiness-heading">
        <SectionHeader
          title={<span id="checkout-readiness-heading">Readiness</span>}
          description={
            readiness
              ? `What the Rekey page needs in each mode. Last run ${formatDateTime(readiness.ranAt)}.`
              : 'What the Rekey page needs in each mode. Checks have not run yet.'
          }
          action={
            <ActionForm action={runChecks.bind(null, applicationId)}>
              <SubmitButton pendingLabel="Running…">Run checks</SubmitButton>
            </ActionForm>
          }
        />
        {readiness && (
          <div className="grid gap-4 md:grid-cols-2">
            <Column title="Test" checks={readiness.test} />
            <Column title="Live" checks={readiness.live} />
          </div>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="checkout-activity-heading">
        <SectionHeader title={<span id="checkout-activity-heading">Recent activity</span>} />
        <Card className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium text-[var(--color-muted-fg)]">Last webhook received</p>
            {status.lastWebhooks.length === 0 ? (
              <p>None yet</p>
            ) : (
              status.lastWebhooks.map((w) => (
                <p key={w.provider}>
                  {w.provider} ({w.mode}): {formatDateTime(w.receivedAt)}
                </p>
              ))
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-[var(--color-muted-fg)]">Last Rekey-page checkout completed</p>
            <p>Test: {status.lastEmbeddedCompleted.test ? formatDateTime(status.lastEmbeddedCompleted.test) : 'none'}</p>
            <p>Live: {status.lastEmbeddedCompleted.live ? formatDateTime(status.lastEmbeddedCompleted.live) : 'none'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-[var(--color-muted-fg)]">Fallbacks, last 7 days</p>
            <p className="tabular-nums">{status.fallbackCount}</p>
            {status.recentFallbacks.slice(0, 5).map((f) => (
              <p key={f.at} className="text-xs text-[var(--color-muted-fg)]">
                {formatDateTime(f.at)}: {CHECK_LABEL[f.check as CheckoutReadinessCheck['id']] ?? f.check} ({f.provider}, {f.paymentMode})
              </p>
            ))}
          </div>
        </Card>
      </section>
    </div>
  );
}
