/**
 * The portal dashboard with a buyer holding more than one live subscription.
 *
 * A live e2e run found a buyer paying for both Pro and Basic shown only
 * "Basic, Active", with a "Switch" to Pro, the plan they already paid for.
 * Every live subscription is listed, and no plan the buyer holds is offered.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = '2026-09-01T00:00:00.000Z';

function sub(id: string, planId: string) {
  return {
    id,
    applicationId: 'app_1',
    endUserId: 'eu_1',
    planId,
    status: 'ACTIVE' as const,
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    cancelAt: null,
    canceledAt: null,
    provider: null,
    providerCapabilities: null,
    providerSubId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function plan(id: string, name: string, amount: number) {
  return {
    id,
    applicationId: 'app_1',
    slug: name.toLowerCase(),
    name,
    kind: 'SUBSCRIPTION',
    amount,
    currency: 'USD',
    interval: 'MONTH',
    trialDays: null,
    licenseKind: null,
    licenseSeatsAllowed: null,
    licenseDurationDays: null,
    meterSlug: null,
    pricePerUnitCents: null,
    creditsAmount: null,
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    checkout: { ready: true },
  };
}

const client = {
  getSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  getPlans: vi.fn(async () => ({
    items: [plan('p_basic', 'Basic', 1000), plan('p_pro', 'Pro', 2000), plan('p_team', 'Team', 5000)],
  })),
  listBillingProviders: vi.fn(async () => ({ providers: [] })),
  listPayments: vi.fn(async () => ({ items: [] })),
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
  checkoutAction: async () => undefined,
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
      expect(row).not.toContain('checkout');
    }
    expect(planRow(html, 'Team')).toContain('Continue to checkout');
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
    expect(planRow(html, 'Pro')).toContain('Continue to checkout');
  });
});
