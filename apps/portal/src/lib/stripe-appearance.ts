/**
 * How the Application's colours reach Stripe's Payment Element. Computed on
 * the server, where the branding filters live, and handed to the client
 * component as plain data.
 */

import type { CheckoutPageOrder } from '@rekey.dev/shared-types';
import { safeCssColor } from './config';
import { readableAccent, readableSurface } from './checkout-format';
import type { StripeAppearance } from './stripe-elements';

const FONT_STACK = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/**
 * The Payment Element themed like the page around it: the same accent and
 * surface the page's CSS variables take, after the same contrast checks, and
 * the page's text colour and font. Only colours that passed `safeCssColor`
 * ever reach Stripe.
 *
 * @example
 * stripeAppearance({ primaryColor: '#4f46e5', surfaceColor: null }).variables.colorPrimary; // '#4f46e5'
 */
export function stripeAppearance(merchant: Pick<CheckoutPageOrder['merchant'], 'primaryColor' | 'surfaceColor'>): StripeAppearance {
  return {
    theme: 'stripe',
    variables: {
      colorPrimary: readableAccent(safeCssColor(merchant.primaryColor ?? undefined) ?? null),
      colorBackground: readableSurface(safeCssColor(merchant.surfaceColor ?? undefined) ?? null) ?? '#ffffff',
      colorText: '#171717',
      colorDanger: '#b91c1c',
      fontFamily: FONT_STACK,
      borderRadius: '8px',
    },
  };
}
