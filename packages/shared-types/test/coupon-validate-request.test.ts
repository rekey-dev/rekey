/**
 * The coupon preview is sent the same fields as the checkout it predicts, so
 * its request accepts what the checkout's does.
 */

import { describe, expect, it } from 'vitest';
import { CreateCheckoutRequestSchema, ValidateCouponRequestSchema } from '../src/index.js';

const quote = { code: 'LAUNCH50', planSlug: 'pro' };

describe('ValidateCouponRequestSchema', () => {
  it("takes a country as the API does, so a CDN's header can be forwarded as it is", () => {
    for (const country of ['IN', 'in', 'T1', 'XX']) {
      expect(ValidateCouponRequestSchema.safeParse({ ...quote, country }).success).toBe(true);
    }
    for (const country of ['IND', 'I', '1N', 'I N']) {
      expect(ValidateCouponRequestSchema.safeParse({ ...quote, country }).success).toBe(false);
    }
  });

  it('carries the provider and organization the checkout will name', () => {
    const parsed = ValidateCouponRequestSchema.parse({ ...quote, provider: 'stripe', organizationId: 'org_1' });
    expect(parsed).toMatchObject({ provider: 'stripe', organizationId: 'org_1' });
  });

  it('agrees with the checkout request on what a country is', () => {
    const checkout = { planSlug: 'pro', successUrl: 'https://app.example/ok', cancelUrl: 'https://app.example/no' };
    for (const country of ['T1', 'IND']) {
      expect(CreateCheckoutRequestSchema.safeParse({ ...checkout, country }).success).toBe(
        ValidateCouponRequestSchema.safeParse({ ...quote, country }).success,
      );
    }
  });
});
