/**
 * Granting a subscription in one of the plan's currencies.
 *
 * The grant dialog offered only the plan, so every panel grant followed the
 * plan's default price, and a subscriber invoiced in rupees was counted in MRR
 * at the dollar price.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { grantCurrencyControl, grantPlanOptions } from '@/lib/grant-currencies';

interface Call {
  method: string;
  path: string;
  body?: Record<string, string>;
}

const calls: Call[] = [];
let refusal: string | null = null;

class FakePanelApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

vi.mock('@/lib/api', () => ({
  PanelApiError: FakePanelApiError,
  errorQuery: async () => '',
  apiGet: async () => null,
  unlessBusy: () => () => null,
  api: async (call: Call) => {
    calls.push(call);
    if (refusal !== null) throw new FakePanelApiError(refusal);
    return { activated: true };
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({}), headers: async () => new Headers() }));

const { grantSubscription } = await import('@/app/(authed)/applications/[id]/end-users/[euid]/actions');

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries({ planSlug: 'pro', note: 'INV-4012', ...fields })) data.set(name, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>): Promise<URLSearchParams> {
  try {
    await run();
  } catch (err) {
    const match = /^REDIRECT [^?]*\?(.*)$/.exec((err as Error).message);
    if (match) return new URLSearchParams(match[1]);
    throw err;
  }
  throw new Error('no redirect');
}

beforeEach(() => {
  calls.length = 0;
  refusal = null;
});

describe('grantSubscription', () => {
  it('sends the chosen currency', async () => {
    const flags = await redirectOf(() => grantSubscription('app_1', 'eu_1', form({ currency: 'inr' })));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/v1/tenant/applications/app_1/end-users/eu_1/subscriptions');
    expect(calls[0]!.body).toEqual({ planSlug: 'pro', note: 'INV-4012', currency: 'INR' });
    expect(flags.get('granted')).toBe('1');
  });

  it('sends no currency for the plan default, so the subscription follows the plan', async () => {
    await redirectOf(() => grantSubscription('app_1', 'eu_1', form({ currency: '' })));
    expect(calls[0]!.body).toEqual({ planSlug: 'pro', note: 'INV-4012' });
  });

  it.each(['BILLING_PLAN_CURRENCY_UNAVAILABLE', 'BILLING_SUBSCRIPTION_CURRENCY_KEPT'])(
    'reopens the dialog on %s with the plan and currency still chosen',
    async (code) => {
      refusal = code;
      const flags = await redirectOf(() => grantSubscription('app_1', 'eu_1', form({ currency: 'INR' })));
      expect(flags.get('grantError')).toBe(code);
      expect(flags.get('grant')).toBe('1');
      expect(flags.get('planSlug')).toBe('pro');
      expect(flags.get('currency')).toBe('INR');
    },
  );
});

const PLANS = [
  {
    slug: 'pro',
    name: 'Pro',
    amount: 1900,
    currency: 'usd',
    interval: 'MONTH' as const,
    prices: [
      { currency: 'USD', amount: 1900, countries: [], isDefault: true },
      { currency: 'INR', amount: 149900, countries: ['IN'], isDefault: false },
    ],
  },
  {
    slug: 'solo',
    name: 'Solo',
    amount: 900,
    currency: 'EUR',
    interval: 'YEAR' as const,
    prices: [{ currency: 'EUR', amount: 900, countries: [], isDefault: true }],
  },
];

describe('grantPlanOptions', () => {
  it("offers a plan's own price first, then its other currencies", () => {
    expect(grantPlanOptions(PLANS)).toEqual([
      {
        slug: 'pro',
        label: 'Pro ($19.00 / month)',
        prices: [
          { currency: 'USD', price: '$19.00' },
          { currency: 'INR', price: '₹1,499.00' },
        ],
      },
      { slug: 'solo', label: 'Solo (€9.00 / year)', prices: [{ currency: 'EUR', price: '€9.00' }] },
    ]);
  });

  it('drops a currency the chosen plan has no price in', () => {
    const options = grantPlanOptions(PLANS);
    const valueFor = (slug: string, wanted: string): string =>
      grantCurrencyControl(options.find((plan) => plan.slug === slug)?.prices ?? [], { kind: 'none' }, wanted).value;
    expect(valueFor('pro', 'INR')).toBe('INR');
    expect(valueFor('solo', 'INR')).toBe('');
    expect(valueFor('pro', '')).toBe('');
    expect(valueFor('', 'USD')).toBe('');
  });
});

describe('the grant dialog', () => {
  const dir = '../src/app/(authed)/applications/[id]/end-users/[euid]/subscriptions';
  const source = (file: string): string => readFileSync(fileURLToPath(new URL(`${dir}/${file}`, import.meta.url)), 'utf8');

  it('has a currency select whose first option sends nothing, drawn from the choices the grant rule allows', () => {
    const fields = source('GrantPlanFields.tsx');
    const select = /<select\s+name="currency"[\s\S]*?<\/select>/.exec(fields)?.[0] ?? '';
    expect(select).toContain('control.choices.map(');
    expect(select).toContain('disabled={choice.disabled}');
    expect(select).toContain('value={control.value}');
    const first = grantCurrencyControl([{ currency: 'USD', price: '$19.00' }], { kind: 'none' }, '').choices[0];
    expect(first).toEqual({ value: '', label: 'Plan default (USD, $19.00)', disabled: false });
  });

  it("has its own words for both of the API's currency refusals", () => {
    const page = source('page.tsx');
    const map = /const GRANT_ERR[\s\S]*?\n\};/.exec(page)?.[0] ?? '';
    expect(map).toContain('BILLING_PLAN_CURRENCY_UNAVAILABLE:');
    expect(map).toContain('BILLING_SUBSCRIPTION_CURRENCY_KEPT:');
    expect(page).toContain('keptCurrency={keptCurrency}');
  });
});
