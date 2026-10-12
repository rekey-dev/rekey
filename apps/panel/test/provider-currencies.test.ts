/**
 * The provider currency control offers only what the provider publishes, and
 * the credential form sends exactly the ticked codes.
 *
 * It used to be free text, so an operator could type INR for PayPal, which
 * cannot charge it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { offeredCurrencies, submittedCurrencies, tickedCurrencies } from '@/lib/provider-currencies';

const here = path.dirname(fileURLToPath(import.meta.url));
const dialog = readFileSync(
  path.join(here, '../src/app/(authed)/applications/[id]/billing/provider-dialog.tsx'),
  'utf8',
);

describe('provider currencies', () => {
  it('offers the codes the descriptor lists, sorted and named, and nothing else', () => {
    expect(offeredCurrencies(['USD', 'EUR'])).toEqual([
      { code: 'EUR', name: 'Euro' },
      { code: 'USD', name: 'US Dollar' },
    ]);
    const paypal = offeredCurrencies(['USD', 'EUR', 'JPY']).map((option) => option.code);
    expect(paypal).not.toContain('INR');
  });

  it('offers every sellable currency to a provider that takes them all', () => {
    const codes = offeredCurrencies('all-sellable').map((option) => option.code);
    expect(codes).toEqual(expect.arrayContaining(['USD', 'INR', 'JPY', 'HUF']));
    for (const never of ['KWD', 'XAU', 'XXX']) expect(codes).not.toContain(never);
  });

  it('ticks what is stored, less a stored code the provider cannot charge', () => {
    const offered = offeredCurrencies(['USD', 'EUR']);
    expect(tickedCurrencies(['INR', 'usd'], ['EUR'], offered)).toEqual(['USD']);
    expect(tickedCurrencies([], ['EUR'], offered)).toEqual([]);
  });

  it('ticks the usual set for a provider not yet configured', () => {
    expect(tickedCurrencies(undefined, ['EUR'], offeredCurrencies(['USD', 'EUR']))).toEqual(['EUR']);
  });

  it('reads one code per ticked box from the submitted form', () => {
    const form = new FormData();
    for (const code of ['USD', 'eur', 'USD']) form.append('currencies', code);
    expect(submittedCurrencies(form)).toEqual(['USD', 'EUR']);
    expect(submittedCurrencies(new FormData())).toEqual([]);
  });

  it('renders the control from the descriptor, with no free-text currency input', () => {
    expect(dialog).toContain('<CurrencyMultiSelect');
    expect(dialog).toContain('offeredCurrencies(descriptor.supportedCurrencies)');
    expect(dialog).not.toMatch(/<input[^>]*name="currencies"/);
  });
});

describe('currenciesSummary', () => {
  it('lists a short set in order', async () => {
    const { currenciesSummary } = await import('@/lib/provider-currencies');
    expect(currenciesSummary(['usd', 'EUR'])).toEqual({ text: 'EUR, USD', title: 'EUR, USD', none: false });
  });

  it('cuts a long set short and keeps the whole list for the title', async () => {
    const { currenciesSummary } = await import('@/lib/provider-currencies');
    const summary = currenciesSummary(['USD', 'EUR', 'GBP', 'INR'], 2);
    expect(summary.text).toBe('EUR, GBP and 2 more');
    expect(summary.title).toBe('EUR, GBP, INR, USD');
  });

  it('says an empty list is no currency, in the words every surface uses', async () => {
    const { currenciesSummary, NO_CURRENCY_TICKED } = await import('@/lib/provider-currencies');
    expect(NO_CURRENCY_TICKED).toBe('None ticked: this provider is not used for any checkout');
    expect(currenciesSummary([])).toEqual({ text: 'No currency', title: NO_CURRENCY_TICKED, none: true });
  });
});
