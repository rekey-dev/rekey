/**
 * Portal-specific API surface — thin typed wrappers over the two end-user
 * billing endpoints that don't have first-class @rekey.dev/node methods yet
 * (added for the portal: GET /billing/payments, POST /billing/subscription/cancel),
 * plus display helpers shared by the pages.
 */

import 'server-only';
import type { PlanDto, SubscriptionDto } from '@rekey.dev/shared-types';
import { getRelipay } from './relipay';

/** Row shape returned by GET /api/v1/billing/payments (end-user scoped). */
export interface PortalPayment {
  id: string;
  amount: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  description: string | null;
  createdAt: string;
  subscriptionId: string | null;
  planSlug: string | null;
  /** Provider-hosted receipt URL when known; null otherwise. */
  receiptUrl: string | null;
}

/** The signed-in user's own payment history, newest first. */
export async function listMyPayments(accessToken: string, limit?: number): Promise<PortalPayment[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : '';
  return getRelipay().request<PortalPayment[]>('GET', `/api/v1/billing/payments${qs}`, undefined, {
    'X-Rekey-User-Token': accessToken,
  });
}

/** Cancel the signed-in user's current subscription (default: at period end). */
export async function cancelMySubscription(
  accessToken: string,
  opts?: { atPeriodEnd?: boolean },
): Promise<SubscriptionDto> {
  return getRelipay().request<SubscriptionDto>(
    'POST',
    '/api/v1/billing/subscription/cancel',
    { ...(opts?.atPeriodEnd !== undefined && { atPeriodEnd: opts.atPeriodEnd }) },
    { 'X-Rekey-User-Token': accessToken },
  );
}

/** Resolve the plan a subscription is on from the public plan list. */
export function planForSubscription(
  plans: PlanDto[],
  sub: SubscriptionDto | null,
): PlanDto | null {
  if (!sub) return null;
  return plans.find((p) => p.id === sub.planId) ?? null;
}

/** "$9.99 / month" from smallest-currency-unit amount. */
export function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
