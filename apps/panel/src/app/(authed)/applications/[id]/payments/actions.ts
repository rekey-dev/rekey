'use server';

/**
 * Refund a recorded payment through the provider that took it.
 *
 * The amount is typed in the payment's currency the way that currency is
 * written and converted once, here, to the smallest unit the API takes. An
 * empty amount sends none, and the API refunds whatever remains. Repeating a
 * request is safe: the API derives the provider's idempotency key from the
 * payment, what was already refunded and the amount.
 */

import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError, type RefundResult } from '@/lib/api';
import { readRefundAmount } from '@/lib/refunds';

export interface RefundTarget {
  id: string;
  currency: string;
  /** What had not been refunded when the page was rendered, smallest unit. */
  remaining: number;
}

function detail(applicationId: string, payment: RefundTarget, query: string): string {
  return `/applications/${applicationId}/payments/${encodeURIComponent(payment.id)}?${query}`;
}

export async function refundPayment(applicationId: string, payment: RefundTarget, formData: FormData): Promise<void> {
  const read = readRefundAmount(String(formData.get('amount') ?? ''), payment.currency, payment.remaining);
  if (!read.ok) redirect(detail(applicationId, payment, new URLSearchParams({ error: read.code }).toString()));
  const reason = String(formData.get('reason') ?? '').trim();

  let result: RefundResult;
  try {
    result = await api<RefundResult>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/payments/${encodeURIComponent(payment.id)}/refunds`,
      body: { ...(read.amount !== undefined && { amount: read.amount }), ...(reason !== '' && { reason }) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(detail(applicationId, payment, await errorQuery(err)));
    }
    throw err;
  }
  redirect(detail(applicationId, payment, new URLSearchParams({ refunded: String(result.refund.amount) }).toString()));
}
