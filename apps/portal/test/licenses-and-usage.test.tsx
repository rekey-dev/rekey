/**
 * What the customer's plans give them, on the dashboard and the licenses
 * page: features and limits, usage, credits, license keys, the free plan
 * and trials.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RekeyError } from '@rekey.dev/react';
import { PublicPlanDtoSchema, type PublicPlanDto } from '@rekey.dev/shared-types';
import { PLANS, subscription } from './fixtures/billing';

const state = { signedIn: true, devices: true };
const client = {
  getSubscription: vi.fn(async () => null),
  listSubscriptions: vi.fn(async () => ({ items: [] })),
  getPlans: vi.fn(
    async (): Promise<{ items: PublicPlanDto[]; defaultPlanSlug: string | null }> => ({
      items: [PLANS.free, PLANS.proDefault],
      defaultPlanSlug: 'free',
    }),
  ),
  listPayments: vi.fn(async () => ({ items: [] })),
  subscribe: vi.fn(async () => ({ subscription: null, activated: true })),
};

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'rekey_portal_access' ? { name, value: 'at' } : undefined) }),
  headers: async () => new Headers({ 'accept-language': 'en-US,en;q=0.9' }),
}));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getPortalConfig: async () => ({
    slug: 'acme',
    name: 'Acme',
    publishableKey: 'pk_test',
    billingEnabled: true,
    billingSubject: 'user',
    branding: {},
    auth: { devices: state.devices },
  }),
}));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example', rekeyApiUrl: () => 'https://api.example' }));
vi.mock('@/lib/client-ip', () => ({
  API_TIMEOUT_MS: 1000,
  forwardedClientHeaders: async () => ({}),
  publishableKeyCallHeaders: async () => ({}),
}));
vi.mock('@/lib/two-factor', () => ({ redirectWhileTwoFactorOutstanding: async () => undefined }));
vi.mock('@/lib/actions', () => ({ cancelSubscriptionAction: async () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('NOT FOUND');
  },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  getPortalUser: async () => (state.signedIn ? { accessToken: 'at', user: { email: 'a@example.com' } } : null),
  portalClientFor: async () => client,
}));

const { default: DashboardPage } = await import('@/app/(portal)/[slug]/(overview)/page');
const { default: LicensesPage } = await import('@/app/(portal)/[slug]/licenses/page');
const { startFreePlanAction } = await import('@/lib/free-tier-actions');
const { removeLicenseMachineAction } = await import('@/lib/license-actions');

const METER = {
  meterSlug: 'requests',
  name: 'API requests',
  unit: 'requests',
  active: true,
  included: 5000,
  used: 1200,
  remaining: 3800,
  creditsPerUnit: null,
  periodStart: '2026-11-01T00:00:00.000Z',
  periodEnd: '2026-12-01T00:00:00.000Z',
};
const LICENSE = {
  id: 'lic_1',
  applicationId: 'app_1',
  endUserId: 'eu_1',
  organizationId: null,
  planId: 'plan_pro',
  kind: 'SEATS',
  status: 'ACTIVE',
  keyPrefix: 'RK-7Q2F',
  entitlementKey: '',
  expiresAt: '2027-11-01T00:00:00.000Z',
  seatsAllowed: 5,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  revokedAt: null,
};

type Answers = {
  features?: Record<string, unknown>;
  creditBalance?: number;
  meters?: unknown[];
  ledger?: unknown[];
  licenses?: unknown[];
  trials?: unknown[];
  machines?: unknown[];
  organizations?: unknown[];
  release?: () => Response;
};
const MACHINES = [
  { id: 'act_1', label: 'Work laptop', fingerprintHint: 'a1b2c3…', status: 'ACTIVE', firstSeenAt: '2026-11-02T00:00:00.000Z', lastSeenAt: '2026-11-05T00:00:00.000Z' },
  { id: 'act_2', label: null, fingerprintHint: 'ffee01…', status: 'ACTIVE', firstSeenAt: '2026-11-03T00:00:00.000Z', lastSeenAt: '2026-11-04T00:00:00.000Z' },
  { id: 'act_3', label: 'Old desktop', fingerprintHint: '998877…', status: 'RELEASED', firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-02T00:00:00.000Z' },
];

function api({
  features = {},
  creditBalance = 0,
  meters = [],
  ledger = [],
  licenses = [],
  trials = [],
  machines = MACHINES,
  organizations = [],
  release,
}: Answers = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
    if (/^\/api\/v1\/users\/me\/licenses\/[^/]+\/activations$/.test(url.pathname)) {
      return ok({ items: machines, page: { total: machines.length } });
    }
    if (init?.method === 'DELETE' && url.pathname.startsWith('/api/v1/users/me/licenses/') && release) return release();
    switch (url.pathname) {
      case '/api/v1/users/me/organizations':
        return ok({ items: organizations, page: { total: organizations.length } });
      case '/api/v1/billing/entitlements':
        return ok({ features, entitlements: [], creditBalance });
      case '/api/v1/usage/remaining':
        return ok({ endUserId: 'eu_1', organizationId: null, periodStart: '', periodEnd: '', meters, totalMeters: meters.length, truncated: false });
      case '/api/v1/credits/me/ledger':
        return ok({ items: ledger, page: { total: ledger.length } });
      case '/api/v1/users/me/licenses':
        return ok({ items: licenses, page: { total: licenses.length } });
      case '/api/v1/billing/trial-eligibility':
        return ok({ items: trials, page: { total: trials.length }, policy: 'once_per_application', provider: 'stripe' });
    }
    throw new Error(`unexpected call to ${url.pathname}`);
  });
}

async function dashboard(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await DashboardPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}
async function licensesPage(searchParams: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(
    await LicensesPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) }),
  );
}
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const m = /^REDIRECT (.*)$/.exec((err as Error).message);
    if (m) return m[1]!;
    throw err;
  }
  throw new Error('no redirect');
}
function planRow(html: string, name: string): string {
  const row = html.slice(html.indexOf('>Plans<')).split('<li').find((chunk) => chunk.includes(`>${name}</span>`));
  if (!row) throw new Error(`no plan row for ${name}`);
  return row;
}

beforeEach(() => {
  state.signedIn = true;
  state.devices = true;
  client.getPlans.mockResolvedValue({ items: [PLANS.free, PLANS.proDefault], defaultPlanSlug: 'free' });
  client.subscribe.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('the dashboard cards', () => {
  it('shows nothing about entitlements, usage, credits or licenses when there is none', async () => {
    api();
    const html = await dashboard();
    for (const heading of ['What your plan includes', 'Usage this period', '>Credits<', '>Licenses<']) {
      expect(html).not.toContain(heading);
    }
  });

  it('lists features and limits as plain labels and values, the device limit linking to devices', async () => {
    api({ features: { max_devices: 3, api_access: true, beta_reports: false, region: 'eu' } });
    const html = await dashboard();
    expect(html).toContain('What your plan includes');
    expect(html).toMatch(/<dt[^>]*>Devices<\/dt><dd[^>]*>3 · <a href="\/acme\/devices"[^>]*>Manage devices<\/a>/);
    expect(html).toMatch(/<dt[^>]*>Api access<\/dt><dd[^>]*>Included</);
    expect(html).toMatch(/<dt[^>]*>Beta reports<\/dt><dd[^>]*>Not included</);
    expect(html).toMatch(/<dt[^>]*>Region<\/dt><dd[^>]*>eu</);
  });

  it('links no devices page for an application that lists none', async () => {
    state.devices = false;
    api({ features: { max_devices: 3 } });
    expect(await dashboard()).not.toContain('Manage devices');
  });

  it('shows each meter with its usage in words, a meter bar and the reset date', async () => {
    api({ meters: [METER, { ...METER, meterSlug: 'unused', name: 'Unused', included: null, used: 0 }] });
    const html = await dashboard();
    expect(html).toContain('1,200 of 5,000 used');
    expect(html).not.toContain('requests used');
    expect(html).toContain('role="meter" aria-label="API requests" aria-valuemin="0" aria-valuemax="5000" aria-valuenow="1200"');
    expect(html).toContain('style="width:24%"');
    expect(html).toContain('Resets on Dec 1, 2026.');
    expect(html).not.toContain('Unused');
  });

  it('shows the credit balance and recent changes', async () => {
    api({
      creditBalance: 480,
      ledger: [
        { id: 'c2', delta: -20, reason: 'CONSUME', balanceAfter: 480, description: null, createdAt: '2026-11-05T00:00:00.000Z' },
        { id: 'c1', delta: 500, reason: 'PURCHASE', balanceAfter: 500, description: 'Starter pack', createdAt: '2026-11-01T00:00:00.000Z' },
      ],
    });
    const html = await dashboard();
    expect(html).toContain('Balance: <span class="font-medium tabular-nums">480</span>');
    expect(html).toContain('>Used<');
    expect(html).toContain('−20');
    expect(html).toContain('>Starter pack<');
    expect(html).toContain('+500');
  });

  it('links the licenses page when the customer holds a license', async () => {
    api({ licenses: [LICENSE] });
    expect(await dashboard()).toContain('href="/acme/licenses"');
  });
});

describe('the licenses page', () => {
  it('sends a signed-out visitor to sign in', async () => {
    state.signedIn = false;
    expect(await redirectOf(() => licensesPage())).toBe('/acme/login');
  });

  it('shows the key prefix, plan, status, seats and expiry, and says the full key cannot be shown again', async () => {
    api({ licenses: [LICENSE] });
    const html = await licensesPage();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('RK-7Q2F');
    expect(html).toContain('>Pro<');
    expect(html).toContain('>Active<');
    expect(html).toContain('Shared seats · 5 seats · Expires Nov 1, 2027 · Issued Nov 1, 2026');
    expect(html).toContain('The full key was shown once, when it was issued, and cannot be shown again');
  });

  it('lists the machines holding seats, with seats used of total and Remove behind a confirmation', async () => {
    api({ licenses: [LICENSE] });
    const html = await licensesPage();
    expect(html).toContain('2 of 5 seats in use');
    expect(html).toContain('Work laptop');
    expect(html).toContain('Machine ffee01…');
    expect(html).not.toContain('Old desktop');
    expect(html).toContain('aria-label="Remove Work laptop from RK-7Q2F"');
    expect(html).toContain('<dialog');
  });

  it("offers no Remove on an organization's licence unless the customer is an owner or admin there", async () => {
    const pooled = { ...LICENSE, organizationId: 'org_a' };
    const org = (baseRole: string) => [{ id: 'org_a', name: 'Alpha', slug: 'alpha', role: baseRole, baseRole, metadata: null, createdAt: '', updatedAt: '' }];
    api({ licenses: [pooled], organizations: org('MEMBER') });
    const asMember = await licensesPage();
    expect(asMember).toContain('Work laptop');
    expect(asMember).not.toContain('aria-label="Remove');
    vi.restoreAllMocks();
    api({ licenses: [pooled], organizations: org('ADMIN') });
    expect(await licensesPage()).toContain('aria-label="Remove Work laptop from RK-7Q2F"');
  });

  it('removes a machine and says so, and explains a refusal', async () => {
    const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
    const spy = api({ licenses: [LICENSE], release: () => ok({ ok: true, released: true }) });
    expect(await redirectOf(() => removeLicenseMachineAction('acme', 'lic_1', 'act_1'))).toBe('/acme/licenses?done=machine_removed');
    expect(spy.mock.calls.map((c) => [c[1]?.method, new URL(String(c[0])).pathname])).toContainEqual([
      'DELETE',
      '/api/v1/users/me/licenses/lic_1/activations/act_1',
    ]);
    expect(await licensesPage({ done: 'machine_removed' })).toContain('The machine was removed, and its seat is free for another.');

    vi.restoreAllMocks();
    api({ licenses: [LICENSE], release: () => ok({ ok: false, reason: 'revoked' }) });
    expect(await redirectOf(() => removeLicenseMachineAction('acme', 'lic_1', 'act_1'))).toBe('/acme/licenses?error=license_inactive');

    vi.restoreAllMocks();
    api({
      licenses: [LICENSE],
      release: () => new Response(JSON.stringify({ success: false, error: { code: 'ORGANIZATION_ROLE_INSUFFICIENT' } }), { status: 403 }),
    });
    expect(await redirectOf(() => removeLicenseMachineAction('acme', 'lic_1', 'act_1'))).toBe(
      '/acme/licenses?error=ORGANIZATION_ROLE_INSUFFICIENT',
    );
    expect(await licensesPage({ error: 'ORGANIZATION_ROLE_INSUFFICIENT' })).toContain(
      "Only an owner or admin of the license&#x27;s organization can remove its machines.",
    );
  });

  it('says what the page is for when there is no license', async () => {
    api();
    expect(await licensesPage()).toContain('License keys you buy for Acme appear here');
  });
});

describe('the free plan', () => {
  it('offers Start on the free default plan when checkout cannot sell it', async () => {
    api();
    const row = planRow(await dashboard(), 'Free');
    expect(row).toContain('Start<span class="sr-only"> Free</span>');
  });

  it('starts the free default plan instead of sending it to checkout when a provider could sell it', async () => {
    const sellable = PublicPlanDtoSchema.parse({ ...PLANS.free, checkout: { ready: true } }) as PublicPlanDto;
    client.getPlans.mockResolvedValue({ items: [sellable], defaultPlanSlug: sellable.slug });
    api();
    const row = planRow(await dashboard(), 'Free');
    expect(row).toContain('Start<span class="sr-only"> Free</span>');
    expect(row).not.toContain('/plans/');
    expect(row).not.toContain('Subscribe');
  });

  it('offers Start on exactly the plan the API names as the default, never on another free plan', async () => {
    const other = PublicPlanDtoSchema.parse({ ...PLANS.free, id: 'plan_free2', slug: 'hobby', name: 'Hobby' }) as PublicPlanDto;
    client.getPlans.mockResolvedValue({ items: [PLANS.free, other], defaultPlanSlug: 'hobby' });
    api();
    const html = await dashboard();
    expect(planRow(html, 'Hobby')).toContain('Start<span class="sr-only"> Hobby</span>');
    expect(planRow(html, 'Free')).not.toContain('Start');
  });

  it('offers no Start when the application has no default plan', async () => {
    client.getPlans.mockResolvedValue({ items: [PLANS.free], defaultPlanSlug: null });
    api();
    expect(planRow(await dashboard(), 'Free')).not.toContain('Start');
  });

  it('shows a customer already on the free plan as current, with no Start', async () => {
    client.listSubscriptions.mockResolvedValueOnce({
      items: [subscription({ id: 'sub_free', planId: 'plan_free', provider: null, providerSubId: null, price: null })],
    } as never);
    api();
    const row = planRow(await dashboard(), 'Free');
    expect(row).toContain('>Current<');
    expect(row).not.toContain('Start');
  });

  it('offers no Start to a customer who already has a paid subscription', async () => {
    client.listSubscriptions.mockResolvedValueOnce({ items: [subscription({ id: 'sub_pro', planId: PLANS.proDefault.id })] } as never);
    api();
    expect(planRow(await dashboard(), 'Free')).not.toContain('Start');
  });

  it('starts it through the free-tier route and says so', async () => {
    client.subscribe.mockResolvedValue({ subscription: null, activated: true });
    expect(await redirectOf(() => startFreePlanAction('acme', null))).toBe('/acme?free=started');
    expect(client.subscribe).toHaveBeenCalledWith('at', undefined);
    api();
    expect(await dashboard({ free: 'started' })).toContain('You are on the free plan.');
  });

  it('explains a refusal', async () => {
    client.subscribe.mockRejectedValue(new RekeyError({ code: 'BILLING_FREE_TIER_ALREADY_CLAIMED', message: 'x', statusCode: 409 }));
    expect(await redirectOf(() => startFreePlanAction('acme', null))).toBe(
      '/acme?free_error=BILLING_FREE_TIER_ALREADY_CLAIMED',
    );
    api();
    expect(await dashboard({ free_error: 'BILLING_FREE_TIER_ALREADY_CLAIMED' })).toContain(
      'You already claimed the free plan for another account or team.',
    );
  });
});

describe('trials', () => {
  it("says a plan includes a trial only on the API's answer", async () => {
    const trialPlan = PublicPlanDtoSchema.parse({ ...PLANS.proDefault, trialDays: 14 }) as PublicPlanDto;
    client.getPlans.mockResolvedValue({ items: [trialPlan] });
    api({ trials: [{ planSlug: 'pro', trialDays: 14, eligible: true, reason: null, redeemedAt: null, endsAt: null }] });
    expect(planRow(await dashboard(), 'Pro')).toContain('Includes a 14-day free trial.');

    vi.restoreAllMocks();
    api({ trials: [{ planSlug: 'pro', trialDays: 14, eligible: false, reason: 'ALREADY_REDEEMED', redeemedAt: '2026-01-01', endsAt: null }] });
    const row = planRow(await dashboard(), 'Pro');
    expect(row).not.toContain('Includes a');
    expect(row).toContain('You have already used your free trial.');
  });
});
