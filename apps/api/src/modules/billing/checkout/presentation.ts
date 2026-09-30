/**
 * Which page a checkout is presented on: the provider's, or the Rekey page.
 *
 * Decided after the geo router has picked a provider and BEFORE anything is
 * reserved or written, so a refusal costs nothing: no processor call, no
 * PENDING row, no coupon or trial slot taken.
 */

import type { Application, Plan } from '@prisma/client';
import type { CheckoutReadinessCheck } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import type { BillingMode, BillingProviderName } from '../credentials.service.js';
import { recordSecurityEvent } from '../../../lib/security-events.js';
import { guardEmbeddedCheckout } from './readiness.js';

export interface CheckoutPresentation {
  embedded: boolean;
  paymentMode: BillingMode;
  /** The check that sent an EMBEDDED checkout back to the provider's page. */
  fellBack: CheckoutReadinessCheck | null;
}

/**
 * @example
 * const p = await resolveCheckoutPresentation({ application, provider: 'paypal', plan, successUrl, cancelUrl });
 * // { embedded: true, paymentMode: 'live', fellBack: null }
 */
export async function resolveCheckoutPresentation(args: {
  application: Application;
  provider: BillingProviderName;
  plan: Plan;
  successUrl: string;
  cancelUrl: string;
  endUserId: string;
  requested?: 'redirect' | 'embedded';
}): Promise<CheckoutPresentation> {
  const row = await prisma.billingCredentials.findUnique({
    where: { applicationId_provider: { applicationId: args.application.id, provider: args.provider } },
    select: { mode: true },
  });
  const paymentMode: BillingMode = row?.mode === 'live' ? 'live' : 'test';
  const setting = paymentMode === 'live' ? args.application.checkoutModeLive : args.application.checkoutModeTest;
  if (setting !== 'EMBEDDED' || args.requested === 'redirect') {
    return { embedded: false, paymentMode, fellBack: null };
  }

  const failed = await guardEmbeddedCheckout({
    application: args.application,
    provider: args.provider,
    mode: paymentMode,
    plan: args.plan,
    successUrl: args.successUrl,
    cancelUrl: args.cancelUrl,
  });
  if (failed === null) return { embedded: true, paymentMode, fellBack: null };

  if (args.application.checkoutFailureMode === 'REFUSE') {
    // The check's own message and fix name internal things (URLs, plan slugs,
    // dates) and this refusal can reach a buyer's browser, so they go to the
    // operator's audit log and the buyer gets a generic answer.
    void recordSecurityEvent({
      type: 'app.checkout_embedded_refused',
      actorType: 'end_user',
      actorId: args.endUserId,
      tenantId: args.application.tenantId,
      applicationId: args.application.id,
      metadata: { check: failed.id, message: failed.message, fix: failed.fix, provider: args.provider, paymentMode },
    });
    throw new RekeyError({
      statusCode: 409,
      code: 'CHECKOUT_EMBEDDED_NOT_READY',
      message: 'This checkout cannot be taken right now.',
      fix: `The Application's operator can see which check failed ("${failed.id}") in Panel → Application → Billing → Setup → Checkout page, or switch the failure behaviour to fall back to the provider's page.`,
      details: { check: failed.id },
    });
  }
  return { embedded: false, paymentMode, fellBack: failed };
}
