/**
 * The portal dashboard with a buyer holding more than one live subscription.
 *
 * A live e2e run found a buyer paying for both Pro and Basic shown only
 * "Basic, Active", with a "Switch" to Pro, the plan they already paid for.
 * Every live subscription is listed, and no plan the buyer holds is offered.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PublicPlanDtoSchema, type PublicPlanDto } from '@rekey.dev/shared-types';
import { PLANS, subscription } from './fixtures/billing';

function sub(id: string, planId: string) {
  return subscription({ id, planId, provider: null, providerSubId: null });
}

function plan(id: string, name: string, amount: number): PublicPlanDto {
  return PublicPlanDtoSchema.parse({
    ...PLANS.team,
    id,
    slug: name.toLowerCase(),
    name,
    prices: [{ ...PLANS.team.prices[0], amount }],
    price: { ...PLANS.team.price, amount, formatted: `$${(amount / 100).toFixed(2)}` },
  }) as PublicPlanDto;
}

const client = {
  getSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  getPlans: vi.fn(
    async (_page?: unknown, _opts?: { accessToken?: string }): Promise<{ items: PublicPlanDto[] }> => ({
      items: [plan('p_basic', 'Basic', 1000), plan('p_pro', 'Pro', 2000), plan('p_team', 'Team', 5000)],
    }),
  ),
  listPayments: vi.fn(async (): Promise<{ items: Array<Record<string, unknown>> }> => ({ items: [] })),
  listOrganizations: vi.fn(async () => ({ items: [] })),
};

vi.mock('@/lib/session', () => ({
  getPortalUser: async () => ({ accessToken: 'at' }),
  portalClientFor: async () => client,
}));
vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => ({ billingSubject: 'user', billingEnabled: true, branding: {} }),
  supportLink: () => undefined,
}));
vi.mock('@/lib/actions', () => ({
  cancelSubscriptionAction: async () => undefined,
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { default: DashboardPage } = await import('@/app/(portal)/[slug]/page');

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await DashboardPage({
    params: Promise.resolve({ slug: 'acme' }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element);
}

/** The Plans card row for one plan. */
function planRow(html: string, name: string): string {
  const plans = html.slice(html.indexOf('>Plans<'));
  const row = plans.split('<li').find((chunk) => chunk.includes(`>${name}</span>`));
  if (!row) throw new Error(`no plan row for ${name}`);
  return row;
}

describe('portal dashboard, several live subscriptions', () => {
  beforeEach(() => {
    client.getSubscription.mockReset();
    client.listSubscriptions.mockReset();
  });

  it('shows every live subscription and offers no plan the buyer holds', async () => {
    client.getSubscription.mockResolvedValue(sub('s_basic', 'p_basic'));
    client.listSubscriptions.mockResolvedValue({ items: [sub('s_pro', 'p_pro'), sub('s_basic', 'p_basic')] });

    const html = await render();
    const subscriptionCard = html.slice(0, html.indexOf('>Plans<'));
    expect(subscriptionCard).toContain('>Pro</span>');
    expect(subscriptionCard).toContain('>Basic</span>');

    for (const held of ['Pro', 'Basic']) {
      const row = planRow(html, held);
      expect(row).toContain('Current');
      expect(row).not.toContain('href="/acme/plans/');
    }
    expect(planRow(html, 'Team')).toContain('href="/acme/plans/team"');
  });

  it('the cancel banner describes the subscription that was cancelled', async () => {
    const basic = { ...sub('s_basic', 'p_basic'), cancelAt: '2026-10-15T00:00:00.000Z' };
    client.getSubscription.mockResolvedValue(sub('s_pro', 'p_pro'));
    client.listSubscriptions.mockResolvedValue({ items: [sub('s_pro', 'p_pro'), basic] });

    const html = await render({ e: 'canceled', sub: 's_basic' });
    const banner = html.slice(0, html.indexOf('>Subscription<'));
    expect(banner).toContain('Your Basic subscription will end on');
    expect(banner).toContain(new Date(basic.cancelAt).toLocaleDateString());
    expect(banner).not.toContain('Pro');
  });

  it('ignores a cancelled id that is not one of the caller\'s subscriptions', async () => {
    const pro = { ...sub('s_pro', 'p_pro'), cancelAt: '2026-10-20T00:00:00.000Z' };
    client.getSubscription.mockResolvedValue(pro);
    client.listSubscriptions.mockResolvedValue({ items: [pro] });

    const html = await render({ e: 'canceled', sub: 's_someone_else' });
    const banner = html.slice(0, html.indexOf('>Subscription<'));
    expect(banner).toContain('Your subscription has been cancelled.');
    expect(banner).not.toContain(new Date(pro.cancelAt).toLocaleDateString());
  });

  it('an automatic checkout refused for lack of a hosted provider reads as unavailable', async () => {
    client.getSubscription.mockResolvedValue(null);
    client.listSubscriptions.mockResolvedValue({ items: [] });
    const html = await render({ error: 'CHECKOUT_UNAVAILABLE' });
    expect(html).toContain('Checkout isn’t available here');
    expect(html).not.toContain('choose another');
  });

  it('still renders from the singular read when the list is unavailable', async () => {
    client.getSubscription.mockResolvedValue(sub('s_basic', 'p_basic'));
    client.listSubscriptions.mockRejectedValue(new Error('older API'));

    const html = await render();
    expect(planRow(html, 'Basic')).toContain('Current');
    expect(planRow(html, 'Pro')).toContain('href="/acme/plans/pro"');
  });
});

describe('portal dashboard, prices', () => {
  beforeEach(() => {
    client.getSubscription.mockReset().mockResolvedValue(null);
    client.listSubscriptions.mockReset().mockResolvedValue({ items: [] });
  });

  it("asks for the catalogue with the buyer's token, so each price is the one they would be charged", async () => {
    client.getPlans.mockClear();
    await render();
    expect(client.getPlans.mock.calls.map((call) => call[1])).toEqual([{ accessToken: 'at' }]);
  });

  it('shows the resolved price in its currency, not the plan default', async () => {
    client.getPlans.mockResolvedValueOnce({ items: [PLANS.proInIndia] });
    const row = planRow(await render(), 'Pro');
    expect(row).toContain('₹1,499.00 /month');
    expect(row).not.toContain('$19.00');
  });

  it("shows a subscription's own price, and that its plan cannot be bought again when checkout is not ready", async () => {
    const held = subscription({ id: 's_pro', planId: PLANS.proBoundUnchargeable.id });
    client.getSubscription.mockResolvedValue(held);
    client.listSubscriptions.mockResolvedValue({ items: [held] });
    client.getPlans.mockResolvedValueOnce({ items: [PLANS.proBoundUnchargeable] });

    const html = await render();
    const subscriptionCard = html.slice(0, html.indexOf('>Plans<'));
    expect(subscriptionCard).toContain('₹1,499.00 /month');
    const row = planRow(html, 'Pro');
    expect(row).toContain('Current');
    expect(row).toContain('cannot be bought again here right now');
  });

  it('shows a plan that cannot be bought as unavailable with a reason, and offers no checkout for it', async () => {
    client.getPlans.mockResolvedValueOnce({ items: [{ ...PLANS.proDefault, checkout: { ready: false } }, PLANS.team] });
    const html = await render();
    const row = planRow(html, 'Pro');
    expect(row).toContain('Not available to buy right now.');
    expect(row).not.toContain('href="/acme/plans/pro"');
    expect(planRow(html, 'Team')).toContain('href="/acme/plans/team"');
  });

  it('does not call a free plan unavailable because it has no checkout', async () => {
    client.getPlans.mockResolvedValueOnce({ items: [PLANS.free] });
    const row = planRow(await render(), 'Free');
    expect(row).not.toContain('Not available');
    expect(row).not.toContain('href="/acme/plans/');
  });
});

describe('portal dashboard, billing history', () => {
  beforeEach(() => {
    client.getSubscription.mockReset().mockResolvedValue(null);
    client.listSubscriptions.mockReset().mockResolvedValue({ items: [] });
  });

  const payment = (over: Record<string, unknown>) => ({
    id: 'pay_1',
    amount: 1900,
    currency: 'USD',
    status: 'SUCCEEDED',
    refundedAmount: 0,
    description: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    subscriptionId: 's_pro',
    planSlug: 'pro',
    receiptUrl: null,
    ...over,
  });

  it("shows each payment in its own currency with what was refunded, and no total across them", async () => {
    client.listPayments.mockResolvedValueOnce({
      items: [
        payment({ id: 'pay_usd' }),
        payment({ id: 'pay_inr', amount: 149900, currency: 'INR', status: 'PARTIALLY_REFUNDED', refundedAmount: 50000 }),
        payment({ id: 'pay_jpy', amount: 1500, currency: 'JPY', status: 'REFUNDED', refundedAmount: 1500 }),
      ],
    });
    const html = await render();
    const history = html.slice(html.indexOf('>Billing history<'));
    expect(history).toContain('$19.00');
    expect(history).toContain('₹1,499.00');
    expect(history).toContain('Refunded ₹500.00 of ₹1,499.00');
    expect(history).toContain('Partially refunded');
    expect(history).toContain('¥1,500');
    expect(history).toContain('Refunded ¥1,500');
    expect(history).not.toMatch(/Total/i);
  });
});
