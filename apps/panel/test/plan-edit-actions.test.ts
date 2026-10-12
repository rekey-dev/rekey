/**
 * The plan forms take money the way it is written (19.99) and send the API
 * minor units, converted once through the currency registry.
 *
 * The edit form used to be labelled "Amount (minor units)" and send
 * `Number(raw)`, beside a create form that took 19.99. Editing a 19.99 plan to
 * "25" sold it at 25 cents.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const calls: Call[] = [];

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
    return {};
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { createPlan, editPlan } = await import('@/app/(authed)/applications/[id]/plans/plan-actions');
const { minorToMajorText, readTypedPlanAmount } = await import('@/lib/money-input');

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const match = /^REDIRECT (.*)$/.exec((err as Error).message);
    if (match) return match[1]!;
    throw err;
  }
  throw new Error('no redirect');
}

const edit = (currency: string, fields: Record<string, string>) =>
  redirectOf(() => editPlan('app_1', { slug: 'pro', currency }, form({ name: 'Pro', ...fields })));

beforeEach(() => {
  calls.length = 0;
});

describe('editPlan', () => {
  it.each([
    ['USD', '25', 2500],
    ['USD', '19.99', 1999],
    ['JPY', '1500', 1500],
    ['HUF', '5000', 500000],
  ])('reads a %s amount typed as %s as %d minor units', async (currency, typed, minor) => {
    const to = await edit(currency, { amount: typed, currency, interval: 'MONTH' });
    expect(to).toBe('/applications/app_1/plans');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ name: 'Pro', price: { currency, amount: minor }, interval: 'MONTH' });
  });

  it('sends an amount of zero as no price, which makes the plan free', async () => {
    await edit('USD', { amount: '0', currency: 'USD', interval: 'MONTH' });
    expect(calls[0]!.body).toEqual({ name: 'Pro', price: null, interval: 'MONTH' });
  });

  it.each([
    ['JPY', '19.99'],
    ['HUF', '5000.50'],
    ['USD', '19.999'],
    ['USD', 'twenty'],
    ['USD', '-5'],
  ])('refuses a %s amount typed as %s and sends nothing', async (currency, typed) => {
    const to = await edit(currency, { amount: typed, currency });
    expect(to).toBe('/applications/app_1/plans?editError=amount&editSlug=pro');
    expect(calls).toEqual([]);
  });

  it('reads the amount in the currency typed beside it, not the one the plan had', async () => {
    await edit('USD', { amount: '1500', currency: 'jpy' });
    expect(calls[0]!.body).toEqual({ name: 'Pro', price: { currency: 'JPY', amount: 1500 } });
  });

  it('refuses a new currency with no amount: the stored number would mean something else', async () => {
    const to = await edit('USD', { currency: 'JPY' });
    expect(to).toContain('editError=amount');
    expect(calls).toEqual([]);
  });

  it('sends no price at all for a name-only edit of a registered plan', async () => {
    await edit('USD', {});
    expect(calls[0]!.body).toEqual({ name: 'Pro' });
  });

  it('prefills the field with text that reads back to the same amount', () => {
    for (const [minor, currency, text] of [
      [1999, 'USD', '19.99'],
      [2500, 'USD', '25'],
      [5, 'USD', '0.05'],
      [0, 'USD', '0'],
      [1500, 'JPY', '1500'],
      [500000, 'HUF', '5000'],
    ] as const) {
      expect(minorToMajorText(minor, currency), `${minor} ${currency}`).toBe(text);
      expect(readTypedPlanAmount(text, currency)).toEqual({ ok: true, minor });
    }
  });
});

describe('createPlan', () => {
  const create = (fields: Record<string, string>) =>
    redirectOf(() => createPlan('app_1', form({ slug: 'metered', name: 'Metered', kind: 'USAGE', meterSlug: 'calls', amount: '0', ...fields })));

  it('sends a usage plan with no base fee as its meter alone: no price, and nothing per unit', async () => {
    await create({ currency: 'USD' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ slug: 'metered', name: 'Metered', interval: 'MONTH', kind: 'USAGE', meterSlug: 'calls' });
  });

  it.each([
    ['USD', '19.99', 1999],
    ['JPY', '1500', 1500],
    ['HUF', '5000', 500000],
  ])('sends a %s amount typed as %s as `price` with %d minor units', async (currency, typed, minor) => {
    await create({ currency, amount: typed });
    expect(calls[0]!.body).toMatchObject({ price: { currency, amount: minor } });
    expect(calls[0]!.body).not.toHaveProperty('amount');
    expect(calls[0]!.body).not.toHaveProperty('currency');
  });

  it('refuses an amount the currency cannot express and sends nothing', async () => {
    const to = await create({ currency: 'JPY', amount: '0.05' });
    expect(to).toContain('error=missing');
    expect(calls).toEqual([]);
  });
});
