/** Reading one payment and its refunds. */

import { apiGet, unlessBusy, type PaymentRow, type RefundRow } from '@/lib/api';
import type { Page } from '@/lib/paginate';

function paymentsPath(applicationId: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/payments`;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'PAYMENT_NOT_FOUND';
}

export type PaymentRead = { ok: true; payment: PaymentRow } | { ok: false; notFound: boolean };

/** One payment by id. `notFound` when no such payment is in this Application. */
export async function getPayment(applicationId: string, paymentId: string): Promise<PaymentRead> {
  try {
    const payment = await apiGet<PaymentRow>(`${paymentsPath(applicationId)}/${encodeURIComponent(paymentId)}`, {
      interruptOnAccessError: false,
    });
    return { ok: true, payment };
  } catch (err) {
    return unlessBusy<PaymentRead>(() => ({ ok: false, notFound: isNotFound(err) }))(err);
  }
}

export type RefundsRead = { ok: true; refunds: RefundRow[]; hasMore: boolean } | { ok: false; notFound: boolean };

/** A payment's refunds, oldest first. `notFound` when no such payment is in this Application. */
export async function getRefunds(applicationId: string, paymentId: string): Promise<RefundsRead> {
  try {
    const page = await apiGet<Page<RefundRow>>(`${paymentsPath(applicationId)}/${encodeURIComponent(paymentId)}/refunds?limit=100`, {
      interruptOnAccessError: false,
    });
    return { ok: true, refunds: page.items, hasMore: page.page.hasMore };
  } catch (err) {
    return unlessBusy<RefundsRead>(() => ({ ok: false, notFound: isNotFound(err) }))(err);
  }
}
