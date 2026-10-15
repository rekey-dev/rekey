/**
 * When an Application's billingConfig.billingSubject is 'org', a checkout that
 * names no beneficiary organization must fail fast with a clear hint instead of
 * silently creating a user-subject subscription. The guard runs before any DB /
 * plan / provider lookup, so this is a pure unit test of that branch.
 */

import { describe, expect, it } from 'vitest';
import type { Application, EndUser } from '@prisma/client';
import { billingService } from '../src/modules/billing/billing.service.js';

const baseInput = {
  endUser: { id: 'eu_test' } as unknown as EndUser,
  planSlug: 'pro',
  successUrl: 'https://example.com/ok',
  cancelUrl: 'https://example.com/cancel',
};

function appWithSubject(billingSubject: 'user' | 'org'): Application {
  return {
    id: `app_${billingSubject}`,
    slug: `app-${billingSubject}`,
    billingConfig: { provider: 'stripe', enabled: true, billingSubject },
  } as unknown as Application;
}

describe('checkout enforces org billing subject', () => {
  it('rejects checkout with no organization when billingSubject=org', async () => {
    await expect(
      billingService.createCheckoutSession({ application: appWithSubject('org'), ...baseInput }),
    ).rejects.toMatchObject({ code: 'BILLING_ORGANIZATION_REQUIRED' });
  });
});
