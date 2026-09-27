/**
 * The provider call at the heart of `createCheckoutSession`, in both
 * presentations, and the `CheckoutSession` row that records it.
 *
 * An EMBEDDED checkout mints its page token BEFORE the provider call, because
 * the page URL is the provider's return URL. The token leaves this module only
 * inside the returned page URL; the row keeps its hash.
 */

import type { BillingProvider, CheckoutSessionInput } from '../providers/types.js';
import type { BillingMode } from '../credentials.service.js';
import { mintCheckoutToken } from './token.js';
import { checkoutPageUrl, recordCheckoutSession, type EmbeddedSessionMetadata } from './sessions.service.js';

export interface IssuedCheckout {
  sessionId: string;
  url: string;
  tokenHash: string | null;
  metadata: EmbeddedSessionMetadata | Record<string, never>;
}

/**
 * @example
 * const issued = await issueProviderCheckout(provider, input, { isOneTime: false, embedded: true, slug: 'acme', paymentMode: 'test', discountAmount: 0 });
 */
export async function issueProviderCheckout(
  provider: BillingProvider,
  input: CheckoutSessionInput,
  opts: { isOneTime: boolean; embedded: boolean; slug: string; paymentMode: BillingMode; discountAmount: number },
): Promise<IssuedCheckout> {
  if (!opts.embedded) {
    const session = opts.isOneTime
      ? await provider.createOneTimeCheckout(input)
      : await provider.createCheckoutSession(input);
    return { sessionId: session.sessionId, url: session.url, tokenHash: null, metadata: {} };
  }
  if (!provider.createEmbeddedCheckout) {
    throw new Error(`provider ${provider.name} declares embedded checkout but does not implement it`);
  }
  const { token, tokenHash } = mintCheckoutToken(opts.paymentMode);
  const pageUrl = checkoutPageUrl(opts.slug, token);
  const result = await provider.createEmbeddedCheckout({
    ...input,
    kind: opts.isOneTime ? 'one_time' : 'recurring',
    returnUrl: pageUrl,
  });
  return {
    sessionId: result.sessionId,
    url: pageUrl,
    tokenHash,
    metadata: {
      client: result.client,
      fallbackUrl: result.fallbackUrl,
      providerPlanId: result.providerPlanId,
      discountAmount: opts.discountAmount,
      trialDays: input.trial?.days ?? 0,
    },
  };
}

/**
 * @example
 * const row = await recordIssuedCheckout(issued, { applicationId, endUserId, subscriptionId, … });
 */
export async function recordIssuedCheckout(
  issued: IssuedCheckout,
  ctx: {
    applicationId: string;
    endUserId: string;
    subscriptionId: string;
    provider: string;
    embedded: boolean;
    paymentMode: BillingMode;
    isOneTime: boolean;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ id: string }> {
  return recordCheckoutSession({
    applicationId: ctx.applicationId,
    endUserId: ctx.endUserId,
    subscriptionId: ctx.subscriptionId,
    provider: ctx.provider,
    providerSessionId: issued.sessionId,
    embedded: ctx.embedded,
    paymentMode: ctx.paymentMode,
    kind: ctx.isOneTime ? 'one_time' : 'recurring',
    successUrl: ctx.successUrl,
    cancelUrl: ctx.cancelUrl,
    tokenHash: issued.tokenHash,
    metadata: issued.metadata,
  });
}
