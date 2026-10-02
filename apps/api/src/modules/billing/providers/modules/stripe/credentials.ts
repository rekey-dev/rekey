/**
 * The Stripe credential form and its rules. Keys match the stored encrypted
 * blobs exactly (`apiKey`, `webhookSecret`, `publishableKey`).
 */

import { RekeyError } from '../../../../../lib/error.js';
import { stripeKeyMode } from '../../stripe-key-mode.js';
import type { CredentialField } from '../../module-types.js';

export const stripeCredentialSchema: CredentialField[] = [
  {
    key: 'apiKey',
    label: 'Secret key',
    secret: true,
    placeholder: 'sk_live_… / sk_test_…',
    help: 'Stripe Dashboard → Developers → API keys.',
    pattern: { prefix: 'sk_', message: 'Stripe `apiKey` must start with `sk_` (live or test).' },
  },
  {
    key: 'webhookSecret',
    label: 'Webhook signing secret',
    secret: true,
    optional: true,
    placeholder: 'whsec_…',
    help: 'Leave blank and auto-configure the webhook, or paste it from Stripe → Developers → Webhooks.',
    pattern: {
      prefix: 'whsec_',
      message: 'Stripe `webhookSecret`, when provided, must start with `whsec_`.',
    },
    webhookRole: 'secret',
  },
  {
    key: 'publishableKey',
    label: 'Publishable key',
    secret: false,
    optional: true,
    placeholder: 'pk_live_… / pk_test_…',
    help: 'Only for the Rekey checkout page. Stripe Dashboard → Developers → API keys, in the same mode as the secret key.',
    pattern: { prefix: 'pk_', message: 'Stripe `publishableKey`, when provided, must start with `pk_` (live or test).' },
  },
];

/**
 * A publishable key in the other mode from the secret key is refused: its
 * sessions would be invisible to the checkout page's Stripe.js.
 *
 * @example
 * validateStripeCredentials({ apiKey: 'sk_live_1', publishableKey: 'pk_test_1' }); // throws BILLING_CREDENTIALS_INVALID
 */
export function validateStripeCredentials(creds: Record<string, string>): void {
  const publishable = stripeKeyMode(creds.publishableKey);
  const secret = stripeKeyMode(creds.apiKey);
  if (publishable === null || secret === null || publishable === secret) return;
  throw new RekeyError({
    statusCode: 400,
    code: 'BILLING_CREDENTIALS_INVALID',
    message: `The Stripe publishable key is a ${publishable} key and the secret key is a ${secret} key.`,
    fix: `Copy the ${secret} publishable key (pk_${secret}_…) from Stripe Dashboard → Developers → API keys, with the dashboard in the same mode as the secret key.`,
  });
}

/**
 * @example
 * detectStripeMode({ apiKey: 'sk_live_1' }); // 'live'
 */
export function detectStripeMode(creds: Record<string, string>): 'test' | 'live' | null {
  // Stripe secret keys are self-describing. Anything else, a restricted
  // key, a typo, a future prefix, is `null`, NOT 'test': claiming "test"
  // for a key we don't recognise is how a live credential ends up stored
  // against a development application.
  const apiKey = creds.apiKey ?? '';
  if (apiKey.startsWith('sk_live_')) return 'live';
  if (apiKey.startsWith('sk_test_')) return 'test';
  return null;
}
