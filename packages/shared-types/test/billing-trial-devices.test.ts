/**
 * Wire contracts for the 2.2.0 public billing + device surface.
 *
 * Same posture as wire-contract.test.ts: the runtime half. What is pinned here
 * is that a field the API accepts or sends actually survives a parse, because
 * `z.object` is non-strict and therefore DROPS anything it does not declare.
 * That is the failure mode these three schemas had: the field existed on the
 * wire and vanished on the way through the type.
 */

import { describe, expect, it } from 'vitest';
import {
  CreateCheckoutRequestSchema,
  DeviceLimitDetailsSchema,
  TrialEligibilityDtoSchema,
} from '../src/index.js';

const CHECKOUT = {
  planSlug: 'pro',
  successUrl: 'https://app.example.com/billing?status=ok',
  cancelUrl: 'https://app.example.com/billing?status=cancel',
};

describe('CreateCheckoutRequestSchema: allowWithoutTrial', () => {
  it('carries allowWithoutTrial through a parse', () => {
    // The documented escape hatch from the 409 BILLING_TRIAL_ALREADY_USED.
    // Undeclared, a non-strict z.object dropped it silently, so the one field
    // that turns that refusal into a sale never reached the wire and callers
    // had to cast around the type to send it.
    const parsed = CreateCheckoutRequestSchema.parse({ ...CHECKOUT, allowWithoutTrial: true });
    expect(parsed.allowWithoutTrial).toBe(true);
  });

  it('leaves it absent when the caller has not acknowledged full price', () => {
    // Absence is meaningful: it is what makes checkout REFUSE an ineligible
    // buyer rather than quietly charge them today.
    const parsed = CreateCheckoutRequestSchema.parse(CHECKOUT);
    expect(parsed.allowWithoutTrial).toBeUndefined();
  });

  it('rejects a non-boolean acknowledgement', () => {
    expect(
      CreateCheckoutRequestSchema.safeParse({ ...CHECKOUT, allowWithoutTrial: 'yes' }).success,
    ).toBe(false);
  });
});

describe('TrialEligibilityDtoSchema', () => {
  /** The body `GET /api/v1/billing/trial-eligibility` actually returns. */
  const BODY = {
    items: [
      {
        planSlug: 'pro',
        trialDays: 14,
        eligible: true,
        reason: null,
        redeemedAt: null,
        endsAt: null,
      },
      {
        planSlug: 'scale',
        trialDays: 30,
        eligible: false,
        reason: 'ALREADY_REDEEMED',
        redeemedAt: '2026-01-05T00:00:00.000Z',
        endsAt: null,
      },
    ],
    page: { total: 2, limit: 50, offset: 0, hasMore: false },
    policy: 'once_per_application',
    provider: 'stripe',
  };

  it('parses the whole envelope, not just items + page', () => {
    const parsed = TrialEligibilityDtoSchema.parse(BODY);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.page.total).toBe(2);
    expect(parsed.policy).toBe('once_per_application');
    // The endpoint's own description tells callers to read `provider` and
    // re-ask when the buyer changes processor, so a type that dropped it made
    // the documented flow impossible to follow.
    expect(parsed.provider).toBe('stripe');
  });

  it('keeps the refusal reason and its timestamp', () => {
    const parsed = TrialEligibilityDtoSchema.parse(BODY);
    expect(parsed.items[1]!.reason).toBe('ALREADY_REDEEMED');
    expect(parsed.items[1]!.redeemedAt).toBe('2026-01-05T00:00:00.000Z');
  });

  it('rejects a policy the API does not define', () => {
    expect(
      TrialEligibilityDtoSchema.safeParse({ ...BODY, policy: 'once_per_fortnight' }).success,
    ).toBe(false);
  });
});

describe('DeviceLimitDetailsSchema', () => {
  /** What auth.service.ts puts on a DEVICE_LIMIT_REACHED envelope. */
  const DETAILS = {
    limit: 3,
    devices: [
      {
        id: 'dev_1',
        label: "Adam's MacBook",
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'dev_2',
        label: null,
        firstSeenAt: '2026-01-02T00:00:00.000Z',
        lastSeenAt: '2026-02-02T00:00:00.000Z',
      },
    ],
  };

  it('parses the details the refusal actually carries', () => {
    // The error's `fix` tells the client to offer "release one of these", and
    // the caller has no session yet (that is why sign-in refused), so this list
    // has to be readable off the thrown error rather than re-fetched.
    const parsed = DeviceLimitDetailsSchema.parse(DETAILS);
    expect(parsed.limit).toBe(3);
    expect(parsed.devices.map((d) => d.id)).toEqual(['dev_1', 'dev_2']);
  });

  it('allows an unlabelled device', () => {
    const parsed = DeviceLimitDetailsSchema.parse(DETAILS);
    expect(parsed.devices[1]!.label).toBeNull();
  });

  it('rejects a fractional limit', () => {
    expect(DeviceLimitDetailsSchema.safeParse({ ...DETAILS, limit: 2.5 }).success).toBe(false);
  });
});
