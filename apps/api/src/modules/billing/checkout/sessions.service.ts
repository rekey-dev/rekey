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
import type { CheckoutPageClient, CheckoutPageView } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { hostedPortalUrl, portalBaseOrigin } from '../../../lib/portal-origins.js';
import { recordSecurityEvent } from '../../../lib/security-events.js';
import { CHECKOUT_SESSION_LIFETIME_MS } from '../checkout-sessions.js';
import type { BillingMode } from '../credentials.service.js';
import { lookupHashFor } from './token.js';
import { safeColor, safeText, safeUrl } from '../../../lib/branding.js';

/**
 * Metadata stored on an EMBEDDED session. `client` is sent to the page;
 * `fallbackUrl` only through the host-checked fallback route; the rest stays
 * server-side.
 */
export interface EmbeddedSessionMetadata {
  client: CheckoutPageClient;
  fallbackUrl: string;
  providerPlanId: string;
  discountAmount: number;
  trialDays: number;
}

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
  metadata: EmbeddedSessionMetadata | Record<string, never>;
}): Promise<CheckoutSession> {
  return prisma.checkoutSession.create({
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
      expiresAt: new Date(Date.now() + CHECKOUT_SESSION_LIFETIME_MS),
      metadata: input.metadata as unknown as Prisma.InputJsonObject,
    },
  });
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
    if (expired.count === 1) return { ...session, status: 'EXPIRED' };
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
      endUser: { select: { email: true } },
      subscription: { select: { plan: { select: { name: true, amount: true, currency: true, interval: true, kind: true, licenseKind: true } } } },
    },
  });
  const meta = session.metadata as unknown as EmbeddedSessionMetadata;
  const plan = detail.subscription.plan;
  const oneTime = session.kind === 'ONE_TIME';
  const totalDueToday = meta.trialDays > 0 ? 0 : Math.max(0, plan.amount - meta.discountAmount);
  return {
    ...base,
    status: session.status === 'CONFIRMING' ? 'confirming' : 'open',
    returnUrl: session.cancelUrl,
    order: {
      merchant: merchantOf(session.application),
      plan: {
        name: plan.name,
        amount: plan.amount,
        currency: plan.currency,
        interval: oneTime ? null : plan.interval,
        kind: oneTime ? 'one_time' : 'recurring',
      },
      discountAmount: meta.discountAmount,
      totalDueToday,
      buyerEmail: detail.endUser.email,
      successUrl: session.successUrl,
      cancelUrl: session.cancelUrl,
      manageUrl: manageUrlOf(session.application),
      expiresAt: session.expiresAt.toISOString(),
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
};

/**
 * The provider's own hosted page for this same order, for the fallback link.
 * Only an https URL on the provider's own host is ever returned, so a
 * tampered row cannot turn the link into an open redirect.
 *
 * @example
 * const { url } = await checkoutFallbackUrl('chk_live_…'); // https://www.paypal.com/checkoutnow?ba_token=…
 */
export async function checkoutFallbackUrl(token: string): Promise<{ url: string }> {
  const session = await settle(await sessionForToken(token));
  if (session.status !== 'OPEN') {
    throw new RekeyError({
      statusCode: 409,
      code: session.status === 'COMPLETE' ? 'CHECKOUT_SESSION_COMPLETE' : 'CHECKOUT_SESSION_EXPIRED',
      message: session.status === 'COMPLETE' ? 'This checkout is already paid.' : 'This checkout can no longer be paid here.',
      fix: 'Return to the app you were buying in.',
    });
  }
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
 * Called by the webhook applier once a completion has been applied: the
 * session it named is COMPLETE. Only the webhook reaches this.
 *
 * @example
 * await markCheckoutSessionComplete(ev.applicationId, ev.checkoutSessionId);
 */
export async function markCheckoutSessionComplete(applicationId: string, providerSessionId: string): Promise<void> {
  await prisma.checkoutSession.updateMany({
    // EXPIRED too: the webhook is a verified payment, and a buyer who
    // approved just before the session ran out has paid all the same.
    where: { applicationId, providerSessionId, status: { in: ['OPEN', 'CONFIRMING', 'EXPIRED'] } },
    data: { status: 'COMPLETE' },
  });
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
