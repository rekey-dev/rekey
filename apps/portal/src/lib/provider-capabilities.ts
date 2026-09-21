/**
 * The portal's two provider decisions, asked of what a provider can do rather
 * than of its name.
 *
 * Both used to be name checks: `provider === 'external'` on the dashboard, and
 * a hardcoded stripe/paypal/razorpay list in the checkout action that silently
 * dropped a buyer's pick of any other provider and auto-routed them instead.
 * The API already describes every provider it runs (`capabilities`, from its
 * module registry), so a new provider needs no portal release.
 */

import type { BillingProviderCapabilities } from '@rekey.dev/shared-types';

/** The part of a provider list entry these decisions read. */
export interface ProviderInfo {
  provider: string;
  capabilities?: Pick<BillingProviderCapabilities, 'checkout'>;
}

/**
 * Whether this subscription is sold and billed by the operator's own system
 * (an inbound-only provider). Rekey cannot stop the money there, so the portal
 * shows "managed through your billing account" instead of a cancel button that
 * would only 409.
 *
 * Absent capabilities (a server predating the field) mean "not known to be",
 * which keeps the cancel button, and the API's SUBSCRIPTION_MANAGED_EXTERNALLY
 * refusal still explains itself on the existing error path.
 */
export function managedElsewhere(
  subscription: { providerCapabilities?: Pick<BillingProviderCapabilities, 'checkout'> | null } | null | undefined,
): boolean {
  return subscription?.providerCapabilities?.checkout === false;
}

/** Whether buyers can be sent to this provider to pay. Absent `checkout` means yes. */
export function isCheckoutProvider(info: ProviderInfo): boolean {
  return info.capabilities?.checkout !== false;
}

export type CheckoutProviderChoice =
  /** No pick posted: the server-side geo router chooses. */
  | { kind: 'auto' }
  | { kind: 'provider'; provider: string }
  /** Refused with the same code the API would answer, for the page's error banner. */
  | { kind: 'refused'; code: 'BILLING_PROVIDER_INBOUND_ONLY' | 'BILLING_PROVIDER_NOT_AVAILABLE' };

/**
 * Judge the provider a buyer picked against the Application's provider list.
 * A pick the list does not offer, or one that cannot host a checkout, is
 * refused, never dropped: dropping it sends the buyer to a processor they did
 * not choose.
 */
export function resolveCheckoutProvider(raw: string, providers: readonly ProviderInfo[]): CheckoutProviderChoice {
  if (raw === '') return { kind: 'auto' };
  const match = providers.find((p) => p.provider === raw);
  if (!match) return { kind: 'refused', code: 'BILLING_PROVIDER_NOT_AVAILABLE' };
  if (!isCheckoutProvider(match)) return { kind: 'refused', code: 'BILLING_PROVIDER_INBOUND_ONLY' };
  return { kind: 'provider', provider: match.provider };
}
