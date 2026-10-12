/**
 * A plan's price forms: what a countries-only edit sends, and what survives a
 * save.
 *
 * The countries form used to send back the amount the page was rendered with.
 * On a page older than a change to that amount, the API read the stale number
 * as an edit to a registered price and refused with PLAN_PRICE_IMMUTABLE.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  method: string;
  path: string;
  body?: { amount?: number; countries?: string[]; localPrices?: string };
}

const calls: Call[] = [];
let plans: Array<{ id: string; prices?: Array<{ currency: string; amount: number; countries: string[] }> }> = [];

class FakePanelApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

vi.mock('@/lib/api', () => ({
  PanelApiError: FakePanelApiError,
  errorQuery: async (_err: unknown, flags: Record<string, string>) => new URLSearchParams(flags).toString(),
  api: async (call: Call) => {
    calls.push(call);
    return call.method === 'GET' ? { items: plans } : {};
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { savePlanPrice, savePlanPriceAmount, savePlanPriceCountries, setPlanLocalPrices } = await import(
  '@/app/(authed)/applications/[id]/plans/price-actions'
);
const { isNewAdd } = await import('@/lib/plan-prices');

const PLAN = { id: 'plan_1', slug: 'pro' };

function form(countries: string): FormData {
  const data = new FormData();
  data.set('countries', countries);
  return data;
}

function priceForm(currency: string, amount: string): FormData {
  const data = form('');
  data.set('currency', currency);
  data.set('amount', amount);
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
  plans = [{ id: 'plan_1', prices: [{ currency: 'INR', amount: 199900, countries: [] }] }];
});

describe('savePlanPriceCountries', () => {
  it('sends the countries and no amount, so a stale page cannot change or trip over the price', async () => {
    const flags = await redirectOf(() => savePlanPriceCountries('app_1', PLAN, 'INR', form('in, np')));
    expect(calls.map((call) => call.method)).toEqual(['PUT']);
    const put = calls[0]!;
    expect(put.path).toBe('/api/v1/tenant/applications/app_1/plans/plan_1/prices/INR');
    expect(put.body).toEqual({ countries: ['IN', 'NP'] });
    expect(flags.get('priceSaved')).toBe('INR');
  });

  it('takes no amount from the page at all', () => {
    // Four parameters: the application, the plan, the currency and the form.
    expect(savePlanPriceCountries.length).toBe(4);
  });

  it('refuses a bad country before reading anything', async () => {
    const flags = await redirectOf(() => savePlanPriceCountries('app_1', PLAN, 'INR', form('IN, IND')));
    expect(flags.get('priceError')).toBe('countries');
    expect(calls).toEqual([]);
  });
});

describe('setPlanLocalPrices', () => {
  it.each(['INHERIT', 'TRUSTED', 'OFF'] as const)('patches the plan by slug with %s and reopens its dialog', async (rule) => {
    const flags = await redirectOf(() => setPlanLocalPrices('app_1', PLAN, rule));
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/v1/tenant/applications/app_1/plans/pro', body: { localPrices: rule } }]);
    expect(flags.get('localPricesSaved')).toBe(rule);
    expect(flags.get('editSlug')).toBe('pro');
  });
});

const plansDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'app',
  '(authed)',
  'applications',
  '[id]',
);
const source = (...parts: string[]): string => readFileSync(path.join(plansDir, ...parts), 'utf8');

/**
 * Source scans, like `form-remount-on-save.test.ts`: what is pinned needs a
 * browser, a server action and a redirect to observe.
 */
describe("a price's amount and remove controls", () => {
  const section = source('plans', 'PlanPricesSection.tsx');
  const table = source('plans', 'PlansTable.tsx');

  it('are enabled or disabled by what the API says about the price, not by a rule of the panel', () => {
    expect(section).toContain('amountLockReason(price)');
    expect(section).toContain('removalLockReason(price)');
    expect(section).not.toContain('registration.status ===');
    expect(table).toContain('defaultPrice?.amountEditable');
  });

  it('carry their reason: the disabled remove button is described by it, and the disabled amount field shows it as its hint', () => {
    const remove = /<button[^>]*disabled[^>]*aria-describedby=\{removalReasonId\}[\s\S]*?<\/button>\s*<span id=\{removalReasonId\}[^>]*>\s*\{removalLocked\}/.exec(section);
    expect(remove).not.toBeNull();
    expect(section).toMatch(/hint=\{amountLocked\}>\s*<input[^>]*\bdisabled\b/);
  });

  it('do not lean on a paragraph beside the list to explain a refusal', () => {
    expect(section).not.toContain('A price cannot be removed while');
    expect(section).not.toContain('cannot be changed here');
  });

  it('offer the local prices rule as a control of its own', () => {
    expect(section).toContain('<PlanLocalPricesControl');
    const control = source('plans', 'PlanLocalPricesControl.tsx');
    expect(control).toContain('setPlanLocalPrices.bind(null, applicationId, ref, choice.value)');
    expect(control).toContain('{choice.consequence}');
  });
});

describe('the add-price form', () => {
  const addForm = source('plans', 'PlanPriceAddForm.tsx');
  const section = source('plans', 'PlanPricesSection.tsx');

  it('holds every field in state, so a refused save keeps what was typed', () => {
    const inputs = addForm.match(/<(?:input|CurrencyInput)[\s\S]*?\/>/g) ?? [];
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      expect(input).toMatch(/\bvalue=\{/);
      expect(input).toMatch(/\bonChange=\{/);
    }
  });

  // Keyed on the saved prices, it remounted empty when another price's
  // countries were saved, and stayed filled after replacing a price with the
  // amount it already had.
  it('is not remounted by the saved prices, and is told about a successful add', () => {
    const tag = /<PlanPriceAddForm[\s\S]*?\/>/.exec(section)?.[0] ?? '';
    expect(tag).not.toMatch(/\bkey=/);
    expect(tag).toContain('addedToken={flash.added}');
    expect(addForm).toContain('isNewAdd(seenToken, addedToken)');
  });

  it('a successful add says so, with a new token each time, even when nothing changed', async () => {
    const first = await redirectOf(() => savePlanPrice('app_1', PLAN, priceForm('inr', '199900')));
    const second = await redirectOf(() => savePlanPrice('app_1', PLAN, priceForm('inr', '199900')));
    expect(first.get('priceSaved')).toBe('INR');
    expect(first.get('priceAdded')).toMatch(/^[0-9a-f]{8}$/);
    expect(second.get('priceAdded')).not.toBe(first.get('priceAdded'));
  });

  it('sends the minor units of the amount typed, at the currency exponent', async () => {
    await redirectOf(() => savePlanPrice('app_1', PLAN, priceForm('huf', '5000')));
    await redirectOf(() => savePlanPrice('app_1', PLAN, priceForm('jpy', '1500')));
    await redirectOf(() => savePlanPrice('app_1', PLAN, priceForm('usd', '19.99')));
    expect(calls.map((call) => [call.path.split('/').pop(), call.body?.amount])).toEqual([
      ['HUF', 500000],
      ['JPY', 1500],
      ['USD', 1999],
    ]);
  });

  it('refuses decimals a currency does not have, before calling the API', async () => {
    const refused = await redirectOf(() => savePlanPrice('app_1', PLAN, priceForm('jpy', '19.99')));
    expect(refused.get('priceError')).toBe('amount');
    expect(calls).toEqual([]);
  });

  it('a refused add and a countries save do not', async () => {
    const refused = await redirectOf(() => savePlanPrice('app_1', PLAN, priceForm('inr', '0')));
    expect(refused.get('priceError')).toBe('amount');
    expect(refused.has('priceAdded')).toBe(false);
    const countries = await redirectOf(() => savePlanPriceCountries('app_1', PLAN, 'INR', form('IN')));
    expect(countries.get('priceSaved')).toBe('INR');
    expect(countries.has('priceAdded')).toBe(false);
  });

  it('clears for an add it has not seen, and for nothing else', () => {
    expect(isNewAdd(undefined, 'a1')).toBe(true);
    expect(isNewAdd('a1', 'b2')).toBe(true);
    expect(isNewAdd('a1', 'a1')).toBe(false);
    expect(isNewAdd('a1', undefined)).toBe(false);
    expect(isNewAdd(undefined, undefined)).toBe(false);
  });
});

describe('billing setup', () => {
  it('the provider dialog remounts when the saved currencies change', () => {
    const dialog = source('billing', 'provider-dialog.tsx');
    const key = /key=\{savedStateKey\(\{([\s\S]*?)\}\)\}/.exec(dialog)?.[1] ?? '';
    for (const field of ['mode', 'countries', 'currencies', 'priority']) {
      expect(key).toContain(`${field}: existing?.${field}`);
    }
  });

  it('every Local prices choice says whether it is pressed', () => {
    const page = source('billing', 'settings', 'page.tsx');
    const group = page.slice(page.indexOf('aria-label="Local prices"'));
    const anyCountry = /<ConfirmButton[\s\S]*?>/.exec(group)?.[0] ?? '';
    expect(anyCountry).toContain('triggerPressed={false}');
  });
});

describe('changing the amount of a price nobody has registered', () => {
  function amountForm(amount: string): FormData {
    const data = new FormData();
    data.set('amount', amount);
    return data;
  }

  beforeEach(() => {
    calls.length = 0;
  });

  it.each([
    ['USD', '19.99', 1999],
    ['JPY', '1500', 1500],
    ['HUF', '5000', 500000],
  ])('sends %s %s as %i minor units and leaves the countries alone', async (currency, typed, minor) => {
    await savePlanPriceAmount('app_1', PLAN, currency, amountForm(typed)).catch(() => undefined);
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.path).toContain(`/prices/${currency}`);
    expect(put?.body).toEqual({ amount: minor });
  });

  it.each([
    ['JPY', '19.99'],
    ['HUF', '5000.50'],
    ['KWD', '1.500'],
    ['USD', '19.999'],
  ])('sends nothing for %s %s', async (currency, typed) => {
    await savePlanPriceAmount('app_1', PLAN, currency, amountForm(typed)).catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});
