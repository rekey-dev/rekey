import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { PlanDto } from '@rekey.dev/node';
import { requireUser } from '@/lib/session';
import { getAccessToken, rekey, RekeyError } from '@/lib/relipay';

async function startCheckout(formData: FormData): Promise<void> {
  'use server';
  const planSlug = String(formData.get('planSlug') ?? '');
  const couponCode = String(formData.get('couponCode') ?? '').trim();
  const access = await getAccessToken();
  if (!access || !planSlug) redirect('/billing?error=missing');

  const origin = process.env.PUBLIC_DEMO_URL ?? 'http://localhost:3032';
  try {
    const { url } = await rekey.billing.createCheckout(access, {
      planSlug,
      successUrl: `${origin}/billing?status=ok`,
      cancelUrl: `${origin}/billing?status=cancel`,
      ...(couponCode ? { couponCode } : {}),
    });
    redirect(url);
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/billing?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
}

const ERR: Record<string, string> = {
  missing: 'Pick a plan first.',
  COUPON_NOT_FOUND: 'That coupon code does not exist.',
  COUPON_INACTIVE: 'That coupon is no longer active.',
  COUPON_EXPIRED: 'That coupon has expired.',
  COUPON_NOT_APPLICABLE: "That coupon doesn't apply to this plan.",
  COUPON_REDEMPTION_LIMIT_REACHED: 'That coupon has reached its redemption cap.',
  COUPON_USER_LIMIT_REACHED: "You've already redeemed this coupon the maximum number of times.",
  BILLING_PROVIDER_NOT_CONFIGURED:
    'Billing is not configured for this Application. Add Stripe credentials in the Rekey panel.',
};

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

const KIND_LABEL: Record<PlanDto['kind'], string> = {
  SUBSCRIPTION: 'Subscription',
  LICENSE: 'License',
  USAGE: 'Usage-based',
  CREDIT: 'Credit pack',
};

/**
 * Price line varies by plan kind. SUBSCRIPTION recurs per interval; LICENSE is
 * a one-off (perpetual / N-day / seat pack); USAGE is per-unit on top of an
 * optional base fee.
 */
function priceLabel(p: PlanDto): { primary: string; secondary: string } {
  const money = formatMoney(p.amount, p.currency);
  if (p.kind === 'LICENSE') {
    if (p.licenseKind === 'TIMED') return { primary: money, secondary: `for ${p.licenseDurationDays ?? '?'} days` };
    if (p.licenseKind === 'SEATS') return { primary: money, secondary: `${p.licenseSeatsAllowed ?? '?'} seats` };
    return { primary: money, secondary: 'one-time' };
  }
  if (p.kind === 'USAGE') {
    const perUnit = formatMoney(p.pricePerUnitCents ?? 0, p.currency);
    return {
      primary: `${perUnit} / unit`,
      secondary: p.amount > 0 ? `+ ${money} base / ${p.interval.toLowerCase()}` : 'pay as you go',
    };
  }
  if (p.kind === 'CREDIT') {
    return { primary: money, secondary: `${p.creditsAmount ?? '?'} credits` };
  }
  return { primary: money, secondary: `/ ${p.interval.toLowerCase()}` };
}

function ctaLabel(kind: PlanDto['kind']): string {
  if (kind === 'LICENSE') return 'Buy license';
  if (kind === 'USAGE') return 'Start metered plan';
  if (kind === 'CREDIT') return 'Buy credits';
  return 'Subscribe';
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const me = await requireUser();
  const access = (await getAccessToken())!;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const status = typeof sp.status === 'string' ? sp.status : undefined;

  const [plans, subscription] = await Promise.all([
    rekey.billing.getPlans().catch(() => []),
    rekey.billing.getSubscription(access).catch(() => null),
  ]);

  return (
    <main className="min-h-screen px-6 py-12">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Billing</h1>
          <Link href="/dashboard" className="text-sm underline">
            ← Dashboard
          </Link>
        </header>

        <p className="text-sm text-neutral-500">
          Signed in as <code>{me.email}</code>.
        </p>

        {status === 'ok' && (
          <div className="rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
            Checkout succeeded. Your subscription will activate as soon as the provider webhook arrives.
          </div>
        )}
        {status === 'cancel' && (
          <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            Checkout was cancelled — no charge was made.
          </div>
        )}
        {error && (
          <div className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERR[error] ?? error}
          </div>
        )}

        <section className="rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
          <h2 className="text-sm font-medium mb-3">Current subscription</h2>
          {subscription ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-neutral-500">plan</dt>
              <dd className="font-mono text-xs">
                {plans.find((p) => p.id === subscription.planId)?.slug ?? subscription.planId}
              </dd>
              <dt className="text-neutral-500">status</dt>
              <dd>{subscription.status}</dd>
              <dt className="text-neutral-500">renews</dt>
              <dd className="text-xs text-neutral-500">
                {subscription.currentPeriodEnd
                  ? new Date(subscription.currentPeriodEnd).toLocaleString()
                  : '—'}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-neutral-500">No active subscription yet.</p>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium">Plans</h2>
          {plans.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No plans configured for this Application yet. Add some in the Rekey panel
              (<code>/applications/&lt;id&gt;/plans</code>) and they'll appear here.
            </p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {plans.map((p) => (
                <form
                  key={p.id}
                  action={startCheckout}
                  className="rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3"
                >
                  <input type="hidden" name="planSlug" value={p.slug} />
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{p.name}</p>
                      <p className="text-xs text-neutral-500 font-mono truncate">{p.slug}</p>
                    </div>
                    <span className="shrink-0 rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:text-neutral-300">
                      {KIND_LABEL[p.kind]}
                    </span>
                  </div>
                  {(() => {
                    const { primary, secondary } = priceLabel(p);
                    return (
                      <p className="text-xl font-semibold">
                        {primary}
                        <span className="text-xs font-normal text-neutral-500 ml-1">{secondary}</span>
                      </p>
                    );
                  })()}
                  {p.kind === 'USAGE' && p.meterSlug && (
                    <p className="text-xs text-neutral-500">
                      Metered on <code className="font-mono">{p.meterSlug}</code>
                    </p>
                  )}
                  <input
                    type="text"
                    name="couponCode"
                    aria-label="Coupon code"
                    placeholder="Coupon code (optional)"
                    className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs font-mono uppercase"
                  />
                  <button
                    type="submit"
                    className="w-full rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    {ctaLabel(p.kind)}
                  </button>
                </form>
              ))}
            </div>
          )}
        </section>

        <p className="text-xs text-neutral-500 pt-4">
          Plans come from <code>rekey.billing.getPlans()</code>. Checkout via{' '}
          <code>rekey.billing.createCheckout(token, &#123; planSlug, successUrl, cancelUrl &#125;)</code>.
          Activation arrives over the Stripe webhook — not synchronously.
        </p>
      </div>
    </main>
  );
}
