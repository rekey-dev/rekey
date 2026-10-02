/**
 * What the real Razorpay provider sends for the Rekey checkout page, and how
 * it reads Razorpay's answers. The `razorpay` SDK is mocked, so these pin the
 * request bodies and the error handling that the fake provider used by the
 * other suites never exercises.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndUser, Plan } from '@prisma/client';
import { RealRazorpayProvider } from '../src/modules/billing/providers/razorpay.js';
import type { EmbeddedCheckoutInput } from '../src/modules/billing/providers/types.js';

const sdk = vi.hoisted(() => ({
  orders: [] as Record<string, unknown>[],
  subscriptions: [] as Record<string, unknown>[],
  fetchPayment: vi.fn<(id: string) => Promise<unknown>>(),
  fetchSubscription: vi.fn<(id: string) => Promise<unknown>>(),
  capture: vi.fn<(id: string, amount: number, currency: string) => Promise<unknown>>(),
}));

vi.mock('razorpay', () => {
  class FakeRazorpay {
    orders = {
      create: async (body: Record<string, unknown>) => {
        sdk.orders.push(body);
        return { id: 'order_wire1' };
      },
    };
    subscriptions = {
      create: async (body: Record<string, unknown>) => {
        sdk.subscriptions.push(body);
        return { id: 'sub_wire1', short_url: 'https://rzp.io/i/wire1' };
      },
      fetch: (id: string) => sdk.fetchSubscription(id),
    };
    plans = { create: async () => ({ id: 'plan_wire1' }) };
    payments = {
      fetch: (id: string) => sdk.fetchPayment(id),
      capture: (id: string, amount: number, currency: string) => sdk.capture(id, amount, currency),
    };
  }
  return { default: FakeRazorpay };
});

const plan = {
  id: 'plan_local_1',
  slug: 'pack',
  name: '100 credits',
  amount: 19900,
  currency: 'INR',
  interval: 'MONTH',
  metadata: { razorpay: { planId: 'plan_existing' } },
} as unknown as Plan;
const endUser = { id: 'eu_1', email: 'buyer@example.com' } as unknown as EndUser;

function input(kind: 'recurring' | 'one_time', discount?: number): EmbeddedCheckoutInput {
  return {
    application: { id: 'app_1', slug: 'acme' },
    endUser,
    plan,
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/no',
    returnUrl: 'https://portal.example/acme/checkout/chk_test_x',
    kind,
    ...(discount !== undefined && { discount: { amount: discount, currency: 'INR', couponId: 'c1', code: 'save50' } }),
  };
}

const provider = new RealRazorpayProvider({ keyId: 'rzp_test_wire', keySecret: 'secret', webhookSecret: 'whsec' });

function razorpayError(statusCode: number, description: string): Error {
  return Object.assign(new Error(description), { statusCode, error: { description } });
}

beforeEach(() => {
  sdk.orders.length = 0;
  sdk.subscriptions.length = 0;
  sdk.fetchPayment.mockReset();
  sdk.fetchSubscription.mockReset();
  sdk.capture.mockReset();
});

describe('RealRazorpayProvider on the checkout page', () => {
  it('creates an Order for a one-time purchase: amount after the coupon, marked embedded', async () => {
    const result = await provider.createEmbeddedCheckout(input('one_time', 5000));
    expect(sdk.orders).toHaveLength(1);
    const body = sdk.orders[0]!;
    expect(body).toMatchObject({
      amount: 14900,
      currency: 'INR',
      notes: {
        rekey_checkout: 'embedded',
        rekey_application_id: 'app_1',
        rekey_end_user_id: 'eu_1',
        rekey_plan_id: 'plan_local_1',
        rekey_coupon_code: 'save50',
        rekey_discount_amount: '5000',
      },
    });
    expect(typeof body.receipt).toBe('string');
    expect((body.receipt as string).length).toBeLessThanOrEqual(40);
    expect(result).toEqual({
      sessionId: 'order_wire1',
      client: { provider: 'razorpay', keyId: 'rzp_test_wire', sdk: 'razorpay-checkout', target: { kind: 'order', orderId: 'order_wire1' } },
      fallbackUrl: '',
      providerPlanId: null,
    });
  });

  it('creates the same subscription as the redirect flow for a recurring purchase', async () => {
    const result = await provider.createEmbeddedCheckout(input('recurring'));
    expect(sdk.orders).toHaveLength(0);
    expect(sdk.subscriptions[0]).toMatchObject({ plan_id: 'plan_existing', notes: { rekey_end_user_id: 'eu_1', rekey_plan_id: 'plan_local_1' } });
    expect(result.fallbackUrl).toBe('https://rzp.io/i/wire1');
    expect(result.client).toMatchObject({ target: { kind: 'subscription', subscriptionId: 'sub_wire1' } });
  });

  it('reads an unknown payment or subscription as null and rethrows anything else', async () => {
    sdk.fetchPayment.mockRejectedValueOnce(razorpayError(400, 'The id provided does not exist'));
    expect(await provider.getPayment('pay_gone')).toBeNull();
    sdk.fetchSubscription.mockRejectedValueOnce(razorpayError(400, 'The id provided does not exist'));
    expect(await provider.getSubscription('sub_gone')).toBeNull();
    sdk.fetchPayment.mockRejectedValueOnce(razorpayError(401, 'Authentication failed'));
    await expect(provider.getPayment('pay_x')).rejects.toThrow('Authentication failed');
  });

  it('maps a payment and a subscription read', async () => {
    sdk.fetchPayment.mockResolvedValueOnce({ id: 'pay_1', status: 'captured', order_id: 'order_1', amount: 19900, currency: 'inr' });
    expect(await provider.getPayment('pay_1')).toEqual({ id: 'pay_1', status: 'captured', orderId: 'order_1', amount: 19900, currency: 'INR' });
    sdk.fetchSubscription.mockResolvedValueOnce({ id: 'sub_1', status: 'authenticated', plan_id: 'plan_1' });
    expect(await provider.getSubscription('sub_1')).toEqual({ id: 'sub_1', status: 'authenticated', planId: 'plan_1', customId: null });
  });

  it('captures for exactly the amount, and treats "already captured" as success', async () => {
    sdk.capture.mockResolvedValueOnce({});
    await provider.capturePayment('pay_1', 19900, 'INR');
    expect(sdk.capture).toHaveBeenCalledWith('pay_1', 19900, 'INR');
    sdk.capture.mockRejectedValueOnce(razorpayError(400, 'This payment has already been captured'));
    await expect(provider.capturePayment('pay_1', 19900, 'INR')).resolves.toBeUndefined();
    sdk.capture.mockRejectedValueOnce(razorpayError(400, 'Capture amount must be equal to the amount authorized'));
    await expect(provider.capturePayment('pay_1', 1, 'INR')).rejects.toThrow('Capture amount');
  });
});
