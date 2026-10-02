/**
 * The Razorpay-specific parts of the checkout page's readiness checks. Kept
 * apart from readiness.ts, which holds what every provider shares.
 */

import type { CheckoutReadinessCheck } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import type { BillingMode } from '../credentials.service.js';

/**
 * Razorpay has no webhook API, so its webhook is made in the Razorpay
 * dashboard and only its secret is entered in the panel.
 *
 * @example
 * razorpayWebhookFix('Panel → Application → Billing → Setup → Providers → Razorpay');
 */
export function razorpayWebhookFix(where: string): string {
  return `Create the webhook in Razorpay Dashboard → Settings → Webhooks with the URL and events listed under ${where} → Edit, then enter the same secret there.`;
}

/**
 * Check 6 for Razorpay: checkout.js needs the key ID.
 *
 * @example
 * razorpayKeyIdCheck({ keyId: 'rzp_test_…' }).status; // 'PASS'
 */
export function razorpayKeyIdCheck(creds: Record<string, unknown>): CheckoutReadinessCheck {
  if (typeof creds.keyId === 'string' && creds.keyId.length > 0) {
    return {
      id: 'browser_credential',
      provider: 'razorpay',
      status: 'PASS',
      message: 'Razorpay has the public key ID its checkout needs.',
      fix: null,
    };
  }
  return {
    id: 'browser_credential',
    provider: 'razorpay',
    status: 'FAIL',
    message: "The Razorpay key ID is missing. It is a public value, sent only to the checkout page for this Application's sessions.",
    fix: 'Enter the Key ID (Razorpay Dashboard → Settings → API Keys) in Panel → Application → Billing → Setup → Providers → Razorpay → Edit.',
  };
}

/**
 * A WARN while Razorpay has delivered no `order.paid` since its credentials
 * were saved, or null once it has. Razorpay offers no API to read which events
 * a webhook subscribes to, so a delivered event is the only evidence.
 *
 * @example
 * const warn = await razorpayOrderPaidCheck(applicationId, 'live');
 */
export async function razorpayOrderPaidCheck(
  applicationId: string,
  mode: BillingMode,
): Promise<CheckoutReadinessCheck | null> {
  const credential = await prisma.billingCredentials.findUnique({
    where: { applicationId_provider: { applicationId, provider: 'razorpay' } },
    select: { secretsUpdatedAt: true },
  });
  const seen = await prisma.webhookEvent.findFirst({
    where: {
      applicationId,
      provider: 'razorpay',
      mode,
      eventType: 'order.paid',
      receivedAt: { gte: credential?.secretsUpdatedAt ?? new Date(0) },
    },
    select: { id: true },
  });
  if (seen !== null) return null;
  return {
    id: 'webhook',
    provider: 'razorpay',
    status: 'WARN',
    message:
      "Razorpay has not delivered an order.paid event yet. One-time purchases on the Rekey checkout page complete only from order.paid, so a webhook without it takes the buyer's money and never fulfils the order.",
    fix: 'In Razorpay Dashboard → Settings → Webhooks, edit this webhook and tick order.paid. This check passes once Razorpay delivers any order.paid, which a Payment Link purchase also sends.',
  };
}
