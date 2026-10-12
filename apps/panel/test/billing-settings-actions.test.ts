/**
 * The reporting currency action: what it sends, and that a code that is not
 * three letters never reaches the API.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportingCurrencyDtoSchema, SetReportingCurrencyRequestSchema } from '@rekey.dev/shared-types';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}
const calls: Call[] = [];

vi.mock('@/lib/api', () => ({
  PanelApiError: class extends Error {},
  errorQuery: async () => 'error=X',
  api: async (call: Call) => {
    calls.push(call);
    return ReportingCurrencyDtoSchema.parse({ reportingCurrency: 'EUR', name: 'Euro' });
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { setOnUnavailableCurrency, setReportingCurrency } = await import('@/app/(authed)/applications/[id]/billing/actions');

function form(code: string): FormData {
  const data = new FormData();
  data.set('reportingCurrency', code);
  return data;
}

describe('setReportingCurrency', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('sends the code upper-cased, in the shape the API schema takes', async () => {
    await expect(setReportingCurrency('app_1', form(' eur '))).rejects.toThrow(
      'REDIRECT /applications/app_1/billing/settings?saved=reportingCurrency',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.path).toBe('/api/v1/tenant/applications/app_1/billing/reporting-currency');
    expect(SetReportingCurrencyRequestSchema.parse(calls[0]?.body)).toEqual({ reportingCurrency: 'EUR' });
  });

  it.each(['', 'EU', 'EURO', '€'])('sends nothing for %j', async (code) => {
    await expect(setReportingCurrency('app_1', form(code))).rejects.toThrow('error=reportingCurrency');
    expect(calls).toHaveLength(0);
  });
});

describe('setOnUnavailableCurrency', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it.each(['fallback', 'refuse'] as const)('patches the billing config with %s and lands on the settings page', async (choice) => {
    await expect(setOnUnavailableCurrency('app_1', choice)).rejects.toThrow(
      'REDIRECT /applications/app_1/billing/settings?saved=unavailableCurrency',
    );
    expect(calls).toEqual([
      { method: 'PATCH', path: '/api/v1/tenant/applications/app_1/billing-config', body: { onUnavailableCurrency: choice } },
    ]);
  });
});
