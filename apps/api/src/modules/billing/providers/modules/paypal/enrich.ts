/**
 * What a PayPal payload does not say outright and translation has to work
 * out: which capture a refund pays back, and how far a refund has got.
 */

/**
 * The capture a v2 refund resource pays back, read from its `up` link
 * (`…/v2/payments/captures/{id}`). Null when the payload carries no such link.
 *
 * @example
 * refundedCaptureId({ links: [{ rel: 'up', href: 'https://api-m.paypal.com/v2/payments/captures/CAP-1' }] }); // 'CAP-1'
 */
export function refundedCaptureId(resource: { links?: Array<{ rel?: string; href?: string }> } | undefined): string | null {
  for (const link of resource?.links ?? []) {
    if (link.rel !== 'up' || typeof link.href !== 'string') continue;
    const match = /\/captures\/([A-Za-z0-9-]+)$/.exec(link.href);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * @example
 * paypalRefundStatus('PENDING'); // 'pending'
 */
export function paypalRefundStatus(status: string | undefined): 'pending' | 'succeeded' | 'failed' {
  if (status === 'PENDING') return 'pending';
  return status === 'FAILED' || status === 'CANCELLED' ? 'failed' : 'succeeded';
}
