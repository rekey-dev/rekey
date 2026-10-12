/**
 * Refunding a payment from the panel: the amount is typed in the payment's
 * currency and converted once, bounded by what remains, and what the page
 * refuses before the provider is asked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REFUND_BLOCKED_REASONS, TenantPaymentDtoSchema } from '@rekey.dev/shared-types';
import type { PaymentRow } from '@/lib/api';
import { readRefundAmount, refundable, refundRefusal } from '@/lib/refunds';

interface Call {
  method: string;
  path: string;
  body?: { amount?: number; reason?: string };
}
const calls: Call[] = [];
let refusal: string | null = null;
const reads: string[] = [];
let readAnswer: { payment?: PaymentRow; code?: string } = {};

class FakePanelApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
vi.mock('@/lib/api', () => ({
  PanelApiError: FakePanelApiError,
  errorQuery: async (err: FakePanelApiError, flags: Record<string, string>) =>
    new URLSearchParams({ error: err.code, ...flags }).toString(),
  apiGet: async (path: string) => {
    reads.push(path);
    if (readAnswer.payment) return readAnswer.payment;
    throw new FakePanelApiError(readAnswer.code ?? 'INTERNAL');
  },
  unlessBusy:
    <T,>(fallback: () => T) =>
    () =>
      fallback(),
  api: async (call: Call) => {
    calls.push(call);
    if (refusal !== null) throw new FakePanelApiError(refusal);
    return { refund: { amount: call.body?.amount ?? 1900 }, payment: {} };
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { refundPayment } = await import('@/app/(authed)/applications/[id]/payments/actions');
const { getPayment } = await import('@/app/(authed)/applications/[id]/payments/shared');

const AT = '2026-10-12T10:00:00.000Z';
const target = (currency: string, remaining: number) => ({ id: 'pay_1', currency, remaining });

function form(amount: string, reason = ''): FormData {
  const data = new FormData();
  data.set('amount', amount);
  data.set('reason', reason);
  return data;
}

async function landing(run: () => Promise<void>): Promise<URLSearchParams> {
  const message = await run().then(
    () => '',
    (err: Error) => err.message,
  );
  return new URLSearchParams(message.split('?')[1] ?? '');
}

describe('readRefundAmount', () => {
  it.each([
    ['USD', '5', 1900, 500],
    ['USD', '19.00', 1900, 1900],
    ['JPY', '500', 1500, 500],
    ['HUF', '1500', 500000, 150000],
  ])('reads %s %s as %i... of what remains', (currency, typed, remaining, minor) => {
    expect(readRefundAmount(typed, currency, remaining)).toEqual({ ok: true, amount: minor });
  });

  it('reads an empty field as everything that remains, and sends no amount', () => {
    expect(readRefundAmount('  ', 'USD', 1900)).toEqual({ ok: true, amount: undefined });
  });

  it('refuses more than what remains, with the figure', () => {
    expect(readRefundAmount('19.01', 'USD', 1900)).toEqual({
      ok: false,
      code: 'refundExceeds',
      message: 'That is more than the $19.00 that has not been refunded.',
    });
    // 1900 typed for a JPY payment of ¥1,500: a hundredfold slip would let it through.
    expect(readRefundAmount('1900', 'JPY', 1500)).toMatchObject({ ok: false, code: 'refundExceeds' });
  });

  it.each([
    ['JPY', '5.5'],
    ['HUF', '1500.50'],
    ['USD', '5.999'],
    ['KWD', '1.500'],
    ['USD', '0'],
    ['USD', 'five'],
  ])('refuses %s %s as an amount that cannot be charged', (currency, typed) => {
    expect(readRefundAmount(typed, currency, 1_000_000)).toMatchObject({ ok: false, code: 'refundAmount' });
  });
});

describe('refundPayment', () => {
  beforeEach(() => {
    calls.length = 0;
    refusal = null;
  });

  it.each([
    ['USD', '5.00', 1900, 500],
    ['JPY', '500', 1500, 500],
    ['HUF', '1500', 500000, 150000],
  ])('sends %s %s as %i... minor units, converted once', async (currency, typed, remaining, minor) => {
    const landed = await landing(() => refundPayment('app_1', target(currency, remaining), form(typed, 'duplicate charge')));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/tenant/applications/app_1/payments/pay_1/refunds',
      body: { amount: minor, reason: 'duplicate charge' },
    });
    expect(calls[0]?.body?.amount).not.toBe(minor * 100);
    expect(landed.get('refunded')).toBe(String(minor));
    expect([...landed.keys()]).toEqual(['refunded']);
  });

  it('sends no amount for a full refund, so the API works out the remainder', async () => {
    await landing(() => refundPayment('app_1', target('USD', 1400), form('')));
    expect(calls[0]?.body).toEqual({});
  });

  it.each([
    ['USD', '19.01', 1900, 'refundExceeds'],
    ['JPY', '5.5', 1500, 'refundAmount'],
    ['KWD', '1.500', 5000, 'refundAmount'],
  ])('asks the provider for nothing when %s %s cannot be refunded', async (currency, typed, remaining, code) => {
    const landed = await landing(() => refundPayment('app_1', target(currency, remaining), form(typed)));
    expect(calls).toHaveLength(0);
    expect(landed.get('error')).toBe(code);
  });

  it.each(['BILLING_REFUND_EXCEEDS_PAYMENT', 'BILLING_PAYMENT_ALREADY_REFUNDED', 'BILLING_REFUND_UNSUPPORTED'])(
    'lands back on the payment with %s for the page to show inline',
    async (code) => {
      refusal = code;
      const landed = await landing(() => refundPayment('app_1', target('USD', 1900), form('5')));
      expect(landed.get('error')).toBe(code);
      expect(landed.get('refunded')).toBeNull();
    },
  );
});

const payment = (over: Partial<PaymentRow>): PaymentRow => ({
  id: 'pay_1',
  endUserId: null,
  endUserEmail: null,
  subscriptionId: null,
  amount: 1900,
  currency: 'USD',
  refundedAmount: 0,
  verification: 'verified',
  status: 'SUCCEEDED',
  provider: 'stripe',
  refundable: true,
  refundBlockedReason: null,
  providerPaymentId: 'in_1',
  description: null,
  createdAt: AT,
  ...over,
});

describe('what a payment page refuses up front', () => {
  it('offers a refund on a payment the API says is refundable', () => {
    expect(refundRefusal(payment({}), true)).toBeNull();
    expect(refundRefusal(payment({ status: 'PARTIALLY_REFUNDED', refundedAmount: 500 }), true)).toBeNull();
    expect(refundable(payment({ refundedAmount: 500 }))).toBe(1400);
  });

  it('says why not in plain words for every reason the API gives', () => {
    const blocked = (over: Partial<PaymentRow>) => refundRefusal(payment({ refundable: false, ...over }), true);
    expect(blocked({ status: 'FAILED', refundBlockedReason: 'payment_not_succeeded' })).toContain('failed');
    expect(blocked({ status: 'PENDING', refundBlockedReason: 'payment_not_succeeded' })).toContain('not settled');
    expect(blocked({ status: 'REFUNDED', refundedAmount: 1900, refundBlockedReason: 'already_refunded' })).toContain(
      'refunded in full: $19.00 of $19.00',
    );
    // Marked refunded before the amount was recorded: no figure is invented.
    expect(blocked({ status: 'REFUNDED', refundedAmount: 0, refundBlockedReason: 'already_refunded' })).toBe(
      'This payment has been refunded in full. Nothing remains.',
    );
    expect(blocked({ providerPaymentId: null, refundBlockedReason: 'no_provider_charge_id' })).toContain('No provider charge id');
    expect(blocked({ provider: null, refundBlockedReason: 'provider_unknown' })).toContain('no record of which provider');
    expect(blocked({ provider: 'external', refundBlockedReason: 'provider_cannot_refund' })).toContain('cannot issue refunds');
    expect(blocked({ provider: 'paypal', refundBlockedReason: 'provider_not_configured' })).toContain('no credentials');
    for (const reason of REFUND_BLOCKED_REASONS) {
      const words = blocked({ refundBlockedReason: reason });
      expect(words, reason).toBeTruthy();
      expect(words, reason).not.toContain(reason);
    }
  });

  it('does not go by the status alone: a paid payment the API blocks is refused', () => {
    expect(refundRefusal(payment({ refundable: false, refundBlockedReason: 'provider_not_configured' }), true)).not.toBeNull();
  });

  it('tells a reader they cannot issue one', () => {
    expect(refundRefusal(payment({}), false)).toContain('does not include billing changes');
  });

  it('reads a payment row the API schema accepts', () => {
    const row = TenantPaymentDtoSchema.parse(payment({ status: 'PARTIALLY_REFUNDED', refundedAmount: 500 }));
    expect(row.status).toBe('PARTIALLY_REFUNDED');
  });
});

describe('reading one payment', () => {
  beforeEach(() => {
    reads.length = 0;
    readAnswer = {};
  });

  it('asks the API for that payment by id, once, and never scans the list', async () => {
    readAnswer = { payment: payment({ id: 'pay/1' }) };
    expect(await getPayment('app_1', 'pay/1')).toEqual({ ok: true, payment: readAnswer.payment });
    expect(reads).toEqual(['/api/v1/tenant/applications/app_1/payments/pay%2F1']);
  });

  it('tells an id that is not in this Application from a read that failed', async () => {
    readAnswer = { code: 'PAYMENT_NOT_FOUND' };
    expect(await getPayment('app_1', 'pay_x')).toEqual({ ok: false, notFound: true });
    readAnswer = { code: 'INTERNAL' };
    expect(await getPayment('app_1', 'pay_x')).toEqual({ ok: false, notFound: false });
  });
});
