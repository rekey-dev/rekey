/**
 * Billing history — the signed-in user's own payments (GET /billing/payments,
 * strictly caller-scoped server-side). Receipts-lite: rows link to the
 * provider-hosted receipt when one is known; invoice PDFs are a follow-up
 * (docs/ENTERPRISE-ROADMAP.md §4).
 */

import type { ReactNode } from 'react';
import { requireSession } from '@/lib/session';
import { listMyPayments, formatAmount, formatDate } from '@/lib/portal';
import { StatusBadge } from '@/components/status-badge';

export default async function BillingHistoryPage(): Promise<ReactNode> {
  const session = await requireSession();
  const payments = await listMyPayments(session.accessToken);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Billing history</h1>

      <section className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        {payments.length === 0 ? (
          <p className="p-5 text-sm text-[var(--color-muted-fg)]">No payments yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-muted)] text-left text-xs uppercase text-[var(--color-muted-fg)]">
              <tr>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Description</th>
                <th className="px-4 py-2.5 font-medium">Amount</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap px-4 py-3">{formatDate(p.createdAt)}</td>
                  <td className="px-4 py-3 text-[var(--color-muted-fg)]">
                    {p.description ?? p.planSlug ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-medium">
                    {formatAmount(p.amount, p.currency)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {p.receiptUrl && (
                      <a
                        href={p.receiptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium underline underline-offset-2"
                      >
                        Receipt
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-[var(--color-faint-fg)]">
        Need a formal invoice? Contact support — downloadable invoices are coming soon.
      </p>
    </div>
  );
}
