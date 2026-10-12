/**
 * The `CheckoutSession` row: writing it at checkout, reading it for the
 * Rekey-hosted page, and moving it through its states.
 *
 * The page is reached by a bearer token, so every read here starts from the
 * token's hash and answers the same 404 for "no such token" and "not a page
 * this deployment serves". A session that is complete or expired returns no
 * order details and no email, only where to send the buyer back to.
 */

import type { Application, CheckoutSession, PaymentMode, Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { PriceFallbackDtoSchema, formatMoney } from '@rekey.dev/shared-types';
import type { CheckoutPageClient, CheckoutPageView, PriceFallbackDto } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { hostedPortalUrl, portalBaseOrigin } from '../../../lib/portal-origins.js';
import { recordSecurityEvent } from '../../../lib/security-events.js';
import { CHECKOUT_SESSION_LIFETIME_MS } from '../checkout-sessions.js';
import type { BillingMode } from '../credentials.service.js';
import { lookupHashFor } from './token.js';
import { safeColor, safeText, safeUrl } from '../../../lib/branding.js';
import { stripeFallbackUrl } from './stripe-fallback.js';
import { snapshotSubscriptionPrice } from '../subscription-snapshot.js';
import { logCheckoutCompleted, type Origin } from '../money-events.js';
import { logCheckoutExpired } from './expired-event.js';
import { recordPriceFallback } from './price-fallback-event.js';
import type { PriceFallback } from '../checkout-price.js';

/**
 * Metadata stored on an EMBEDDED session. `client` is sent to the page;
 * `fallbackUrl` only through the host-checked fallback route; the rest stays
 * server-side.
 */
export interface EmbeddedSessionMetadata {
  client: CheckoutPageClient;
  /** Null until the provider has a hosted page for this order (Stripe issues one on demand). */
  fallbackUrl: string | null;
  providerPlanId: string | null;
  discountAmount: number;
  trialDays: number;
  /** Written when the checkout charges the default price in place of the one selected, for the page to tell the buyer. */
  priceFallback?: PriceFallbackDto;
}

/** Metadata stored on a REDIRECT session: none. What it charges is in the row's own columns. */
export type RedirectSessionMetadata = Record<string, never>;

export function toPaymentMode(mode: BillingMode): PaymentMode {
  return mode === 'live' ? 'LIVE' : 'TEST';
}

function fromPaymentMode(mode: PaymentMode): BillingMode {
  return mode === 'LIVE' ? 'live' : 'test';
}

/**
 * The page URL for a token. Only called for an EMBEDDED checkout, which the
 * guard allows only when the deployment runs a portal.
 *
 * @example
 * checkoutPageUrl('acme', 'chk_live_…'); // 'https://portal.rekey.dev/acme/checkout/chk_live_…'
 */
export function checkoutPageUrl(slug: string, token: string): string {
  const base = portalBaseOrigin();
  if (base === null) {
    throw new RekeyError({
      statusCode: 503,
      code: 'CHECKOUT_EMBEDDED_NOT_READY',
      message: 'This deployment runs no hosted portal, so there is nowhere to serve the checkout page.',
      fix: 'Set PUBLIC_PORTAL_URL on the API and deploy the portal service (`docker compose --profile full up`).',
    });
  }
  return `${base}/${encodeURIComponent(slug)}/checkout/${token}`;
}

/**
 * Write the row for one issued checkout, in either presentation.
 *
 * @example
 * await recordCheckoutSession({ applicationId, endUserId, subscriptionId, provider: 'paypal', … });
 */
export async function recordCheckoutSession(input: {
  applicationId: string;
  endUserId: string;
  subscriptionId: string;
  provider: string;
  providerSessionId: string;
  embedded: boolean;
  paymentMode: BillingMode;
  kind: 'recurring' | 'one_time';
  successUrl: string;
  cancelUrl: string;
  tokenHash: string | null;
  metadata: EmbeddedSessionMetadata | RedirectSessionMetadata;
  buyerCountry?: string | null;
  buyerCountrySource?: string | null;
  /** The plan price the checkout was opened at, before any discount. */
  price: { currency: string; unitAmount: number };
  /** The coupon discount this checkout carries, in the same currency. 0 with no coupon. */
  discountAmount: number;
  /** The price row that is. Null only for a plan with no flat price. */
  planPriceId: string | null;
  plan: { id: string; slug: string };
  /** The price selected first, when this checkout charges the default instead. */
  priceFallback: PriceFallback | null;
}): Promise<CheckoutSession> {
  return prisma.$transaction(async (tx) => {
    const session = await tx.checkoutSession.create({
      data: {
        applicationId: input.applicationId,
        endUserId: input.endUserId,
        subscriptionId: input.subscriptionId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        mode: input.embedded ? 'EMBEDDED' : 'REDIRECT',
        paymentMode: toPaymentMode(input.paymentMode),
        kind: input.kind === 'one_time' ? 'ONE_TIME' : 'RECURRING',
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        tokenHash: input.tokenHash,
        buyerCountry: input.buyerCountry ?? null,
        buyerCountrySource: input.buyerCountrySource ?? null,
        currency: input.price.currency,
        unitAmount: input.price.unitAmount,
        discountAmount: input.discountAmount,
        chargeAmount: input.price.unitAmount - input.discountAmount,
        planPriceId: input.planPriceId,
        expiresAt: new Date(Date.now() + CHECKOUT_SESSION_LIFETIME_MS),
        metadata: {
          ...input.metadata,
          ...(input.embedded && input.priceFallback !== null && {
            priceFallback: fallbackForPage(input.priceFallback, { ...input.price, id: input.planPriceId ?? '' }),
          }),
        } as unknown as Prisma.InputJsonObject,
      },
    });
    if (input.priceFallback !== null && input.planPriceId !== null) {
      await recordPriceFallback(tx, session, input.plan, input.priceFallback);
    }
    return session;
  });
}

/**
 * The fallback as the checkout page shows it: the price selected first and
 * the default price this session charges, each written for a person.
 */
function fallbackForPage(
  fallback: PriceFallback,
  charged: { id: string; currency: string; unitAmount: number },
): PriceFallbackDto {
  return {
    requested: {
      id: fallback.requested.planPriceId,
      currency: fallback.requested.currency.toUpperCase(),
      amount: fallback.requested.amount,
      formatted: formatMoney(fallback.requested.amount, fallback.requested.currency),
    },
    charged: {
      id: charged.id,
      currency: charged.currency.toUpperCase(),
      amount: charged.unitAmount,
      formatted: formatMoney(charged.unitAmount, charged.currency),
    },
    reason: fallback.reason,
  };
}

/** What the session recorded when it was opened. Anything unreadable is no fallback. */
function storedFallback(value: unknown): PriceFallbackDto | null {
  const parsed = PriceFallbackDtoSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function notFound(): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'CHECKOUT_SESSION_NOT_FOUND',
    message: 'No checkout exists at this address.',
    fix: 'Start the checkout again from the app you were buying in; checkout links are single-purchase and expire after 24 hours.',
  });
}

type SessionWithApp = CheckoutSession & { application: Application };

/**
 * The EMBEDDED session a presented token names, or 404. Never a REDIRECT row,
 * never a disabled Application's.
 *
 * @example
 * const session = await sessionForToken(req.params.token);
 */
export async function sessionForToken(token: string): Promise<SessionWithApp> {
  const tokenHash = lookupHashFor(token);
  if (tokenHash === null) throw notFound();
  const session = await prisma.checkoutSession.findUnique({ where: { tokenHash }, include: { application: true } });
  if (!session || session.mode !== 'EMBEDDED' || session.application.disabledAt !== null) throw notFound();
  return session;
}

function isLive(status: CheckoutSession['status']): boolean {
  return status === 'OPEN' || status === 'CONFIRMING';
}

/** The mode of the provider's credentials right now, or null when they are gone. */
async function currentProviderMode(applicationId: string, provider: string): Promise<BillingMode | null> {
  const row = await prisma.billingCredentials.findUnique({
    where: { applicationId_provider: { applicationId, provider } },
    select: { mode: true },
  });
  if (!row) return null;
  return row.mode === 'live' ? 'live' : 'test';
}

async function expire(session: CheckoutSession): Promise<void> {
  await prisma.checkoutSession.updateMany({
    where: { id: session.id, status: { in: ['OPEN', 'CONFIRMING'] } },
    data: { status: 'EXPIRED' },
  });
}

/**
 * Refuse a session whose recorded payment mode no longer matches its
 * provider's credentials, and expire it so it stays refused. A sandbox
 * subscription is never confirmed against the live API, or the reverse.
 *
 * @example
 * await assertSessionModeCurrent(session, log);
 */
export async function assertSessionModeCurrent(session: SessionWithApp): Promise<void> {
  const current = await currentProviderMode(session.applicationId, session.provider);
  const recorded = fromPaymentMode(session.paymentMode);
  if (current === recorded) return;
  await expire(session);
  await logCheckoutExpired(session.id, 'mode_mismatch');
  void recordSecurityEvent({
    type: 'app.checkout_mode_mismatch',
    actorType: 'system',
    tenantId: session.application.tenantId,
    applicationId: session.applicationId,
    metadata: { checkoutSessionId: session.id, recorded, current, provider: session.provider },
  });
  throw new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_MODE_MISMATCH',
    message: `This checkout was started in ${recorded} mode, and the Application's ${session.provider} credentials are now ${current ?? 'removed'}.`,
    fix: 'Start the checkout again from the app you were buying in, so it runs on the current credentials.',
  });
}

/**
 * Bring a live session's status up to date: expired past its lifetime, and
 * refused after a credential mode switch. Returns the session as it now stands.
 */
async function settle(session: SessionWithApp): Promise<SessionWithApp> {
  if (!isLive(session.status)) return session;
  // Only an OPEN session runs out. A CONFIRMING one was approved at the
  // processor and will complete from its webhook, so expiring it would tell a
  // buyer who has paid that their checkout is gone.
  if (session.status === 'OPEN' && session.expiresAt.getTime() <= Date.now()) {
    const expired = await prisma.checkoutSession.updateMany({
      where: { id: session.id, status: 'OPEN' },
      data: { status: 'EXPIRED' },
    });
    if (expired.count === 1) {
      await logCheckoutExpired(session.id, 'timed_out');
      return { ...session, status: 'EXPIRED' };
    }
    // Moved on (confirmed or completed) since it was read: use what it is now.
    const current = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: session.id }, select: { status: true } });
    return { ...session, status: current.status };
  }
  await assertSessionModeCurrent(session);
  return session;
}

/**
 * The token's session with its status brought up to date (expiry, mode).
 *
 * @example
 * const session = await settleSessionForToken('chk_test_…');
 */
export async function settleSessionForToken(token: string): Promise<SessionWithApp> {
  return settle(await sessionForToken(token));
}

function merchantOf(app: Application): NonNullable<CheckoutPageView['order']>['merchant'] {
  const b = (app.portalBranding ?? {}) as Record<string, unknown>;
  const email = safeText(b.supportEmail, 254);
  return {
    displayName: safeText(b.displayName, 80) ?? app.name,
    logoUrl: safeUrl(b.logoUrl, true),
    primaryColor: safeColor(b.primaryColor),
    backgroundColor: safeColor(b.backgroundColor),
    surfaceColor: safeColor(b.surfaceColor),
    supportEmail: email !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    supportUrl: safeUrl(b.supportUrl, false),
    termsUrl: safeUrl(b.termsUrl, false),
    privacyUrl: safeUrl(b.privacyUrl, false),
    refundUrl: safeUrl(b.refundUrl, false),
  };
}

function manageUrlOf(app: Application): string | null {
  return hostedPortalUrl(app);
}

/**
 * What the checkout page may show for a token.
 *
 * @example
 * const view = await checkoutPageView('chk_test_…');
 * if (view.status === 'open') render(view.order);
 */
export async function checkoutPageView(token: string): Promise<CheckoutPageView> {
  const session = await settle(await sessionForToken(token));
  const base = {
    slug: session.application.slug,
    paymentMode: fromPaymentMode(session.paymentMode),
    provider: session.provider,
  };
  if (session.status === 'COMPLETE') {
    return { ...base, status: 'complete', returnUrl: session.successUrl, order: null };
  }
  if (!isLive(session.status)) {
    return { ...base, status: 'expired', returnUrl: session.cancelUrl, order: null };
  }

  const detail = await prisma.checkoutSession.findUniqueOrThrow({
    where: { id: session.id },
    select: {
      currency: true,
      unitAmount: true,
      chargeAmount: true,
      discountAmount: true,
      endUser: { select: { email: true } },
      subscription: { select: { plan: { select: { name: true, interval: true, kind: true, licenseKind: true } } } },
    },
  });
  const meta = session.metadata as unknown as EmbeddedSessionMetadata;
  const plan = detail.subscription.plan;
  const oneTime = session.kind === 'ONE_TIME';
  // The price this session was opened at and what it charges after its
  // discount: the row's own columns, which is what the provider was sent.
  if (detail.currency === null || detail.unitAmount === null) throw notFound();
  const amount = detail.unitAmount;
  const currency = detail.currency;
  const discountAmount = detail.discountAmount ?? 0;
  const charge = detail.chargeAmount ?? Math.max(0, amount - discountAmount);
  const totalDueToday = !oneTime && meta.trialDays > 0 ? 0 : charge;
  return {
    ...base,
    status: session.status === 'CONFIRMING' ? 'confirming' : 'open',
    returnUrl: session.cancelUrl,
    order: {
      merchant: merchantOf(session.application),
      plan: {
        name: plan.name,
        amount,
        currency,
        interval: oneTime ? null : plan.interval,
        kind: oneTime ? 'one_time' : 'recurring',
      },
      discountAmount,
      totalDueToday,
      buyerEmail: detail.endUser.email,
      successUrl: session.successUrl,
      cancelUrl: session.cancelUrl,
      manageUrl: manageUrlOf(session.application),
      expiresAt: session.expiresAt.toISOString(),
      priceFallback: storedFallback(meta.priceFallback),
      client: meta.client,
    },
  };
}

/**
 * Just the status, for the page's polling.
 *
 * @example
 * await checkoutStatus('chk_test_…'); // { status: 'confirming' }
 */
export async function checkoutStatus(token: string): Promise<{ status: CheckoutPageView['status'] }> {
  const session = await settle(await sessionForToken(token));
  if (session.status === 'COMPLETE') return { status: 'complete' };
  if (session.status === 'CONFIRMING') return { status: 'confirming' };
  return { status: session.status === 'OPEN' ? 'open' : 'expired' };
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Where the "Continue on {provider}" link may send a buyer, per provider. */
const FALLBACK_HOSTS: Record<string, readonly string[]> = {
  paypal: ['www.paypal.com', 'www.sandbox.paypal.com'],
  // A subscription's `short_url`. An order has no link; the page posts it to
  // Razorpay Hosted Checkout instead.
  razorpay: ['rzp.io'],
};

/**
 * The provider's own hosted page for this same order, for the fallback link.
 * A stored URL is only returned when it is https on the provider's own host,
 * so a tampered row cannot turn the link into an open redirect; Stripe's is
 * read from Stripe each time.
 *
 * @example
 * const { url } = await checkoutFallbackUrl('chk_live_…'); // https://www.paypal.com/checkoutnow?ba_token=…
 */
export async function checkoutFallbackUrl(token: string, log?: FastifyBaseLogger): Promise<{ url: string }> {
  const session = await settle(await sessionForToken(token));
  if (session.status !== 'OPEN') {
    throw new RekeyError({
      statusCode: 409,
      code: session.status === 'COMPLETE' ? 'CHECKOUT_SESSION_COMPLETE' : 'CHECKOUT_SESSION_EXPIRED',
      message: session.status === 'COMPLETE' ? 'This checkout is already paid.' : 'This checkout can no longer be paid here.',
      fix: 'Return to the app you were buying in.',
    });
  }
  // Stripe's URL comes straight from Stripe's API on every call, never from
  // the row, so it is trusted as is, including a Checkout custom domain.
  if (session.provider === 'stripe') return { url: await stripeFallbackUrl(session, token, log) };
  const parsed = parseUrl((session.metadata as unknown as Partial<EmbeddedSessionMetadata>).fallbackUrl);
  const hosts = FALLBACK_HOSTS[session.provider] ?? [];
  if (parsed === null || parsed.protocol !== 'https:' || !hosts.includes(parsed.hostname)) {
    throw new RekeyError({
      statusCode: 409,
      code: 'CHECKOUT_FALLBACK_UNAVAILABLE',
      message: "This checkout has no provider page to continue on.",
      fix: 'Return to the app you were buying in and start the checkout again.',
    });
  }
  return { url: parsed.href };
}

/**
 * Called by the webhook applier inside the transaction that activates the
 * subscription: the session a verified completion names becomes COMPLETE, the
 * subscription takes the price that session was opened at, and the billing
 * log records the completed checkout. Returns the session that completed, or
 * null when none did (a redelivery, or an order Rekey holds no session for).
 *
 * The price is written only on this transition. A redelivered completion for
 * a session already COMPLETE finds nothing to flip, so it cannot put an older
 * checkout's price back; and opening a checkout never reaches here, so it
 * cannot change what a paying subscriber is charged against.
 *
 * @example
 * await prisma.$transaction((tx) => completeCheckoutSession(tx, ev.applicationId, ev.checkoutSessionId, origin));
 */
export async function completeCheckoutSession(
  tx: Prisma.TransactionClient,
  applicationId: string,
  providerSessionId: string,
  origin: Origin,
): Promise<{ id: string } | null> {
  // EXPIRED too: the webhook is a verified payment, and a buyer who approved
  // just before the session ran out has paid all the same.
  const open = await tx.checkoutSession.findMany({
    where: { applicationId, providerSessionId, status: { in: ['OPEN', 'CONFIRMING', 'EXPIRED'] } },
    include: { subscription: { select: { plan: { select: { id: true, slug: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  const completed: Array<(typeof open)[number]> = [];
  for (const session of open) {
    const flipped = await tx.checkoutSession.updateMany({
      where: { id: session.id, status: { in: ['OPEN', 'CONFIRMING', 'EXPIRED'] } },
      data: { status: 'COMPLETE' },
    });
    if (flipped.count === 1) completed.push(session);
  }
  for (const session of completed) {
    if (session.currency !== null && session.unitAmount !== null) {
      await snapshotSubscriptionPrice(tx, {
        applicationId,
        subscriptionId: session.subscriptionId,
        planPriceId: session.planPriceId ?? 'default',
        unitAmountOverride: session.unitAmount,
        chargedCurrency: session.currency,
        logged: { cause: 'checkout', checkoutSessionId: session.id, ...origin },
      });
    }
    await logCheckoutCompleted(tx, session, session.subscription.plan, origin);
  }
  return completed[0] ?? null;
}

/**
 * Whether a verified completion may be applied: false when the session it
 * names was recorded in a payment mode the provider's credentials are no
 * longer in. That session is expired, so it stays refused.
 *
 * @example
 * if (!(await completionModeAllowed(appId, sessionId, 'live'))) return;
 */
export async function completionModeAllowed(
  applicationId: string,
  providerSessionId: string,
  verifiedMode: BillingMode | undefined,
): Promise<boolean> {
  if (verifiedMode === undefined) return true;
  const mismatched = await prisma.checkoutSession.findFirst({
    where: { applicationId, providerSessionId, NOT: { paymentMode: toPaymentMode(verifiedMode) } },
    select: { id: true, paymentMode: true, provider: true, application: { select: { tenantId: true } } },
  });
  if (mismatched === null) return true;
  await prisma.checkoutSession.update({ where: { id: mismatched.id }, data: { status: 'EXPIRED' } });
  await logCheckoutExpired(mismatched.id, 'mode_mismatch');
  void recordSecurityEvent({
    type: 'app.checkout_mode_mismatch',
    actorType: 'system',
    tenantId: mismatched.application.tenantId,
    applicationId,
    metadata: {
      checkoutSessionId: mismatched.id,
      recorded: fromPaymentMode(mismatched.paymentMode),
      current: verifiedMode,
      provider: mismatched.provider,
      at: 'completion',
    },
  });
  return false;
}
