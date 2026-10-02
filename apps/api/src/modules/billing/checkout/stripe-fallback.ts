/**
 * The "Continue on Stripe" link for a Stripe checkout on the Rekey page.
 *
 * A Checkout Session in `ui_mode: 'elements'` has no hosted URL, so there is
 * nothing to fall back to until the buyer asks. On that request the elements
 * session is expired at Stripe and a hosted session for the same purchase
 * takes its place, everywhere Rekey looks a session up: the CheckoutSession
 * row, the Subscription's session history, and the coupon and trial
 * reservations bound to it. One payable Stripe session exists at any moment,
 * so the buyer cannot pay twice, and the webhook for the hosted session finds
 * the same Subscription the elements one would have.
 *
 * Later clicks ask Stripe for the hosted session's URL again rather than
 * trusting a stored one, so a Checkout custom domain works every time.
 */

import type { Application, CheckoutSession } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { buildCheckoutSessionMetadata, couponForSession } from '../checkout-sessions.js';
import { getProviderForApplication } from '../providers/index.js';
import type { BillingProvider } from '../providers/types.js';
import { checkoutPageUrl, type EmbeddedSessionMetadata } from './sessions.service.js';

type SessionWithApp = CheckoutSession & { application: Application };

function unavailable(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_FALLBACK_UNAVAILABLE',
    message: 'Stripe could not open its own checkout page for this order.',
    fix: 'Go back to the checkout page and try again in a moment, or return to the app you were buying in and start again.',
  });
}

function paidOrProcessing(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_SESSION_COMPLETE',
    message: 'This checkout is already paid, or its payment is being processed.',
    fix: 'Return to the app you were buying in. The purchase completes when Stripe confirms the payment, which for a bank debit can take a few business days. Do not pay again.',
  });
}

/**
 * Stable per replacement: the row id and the session being replaced. A retry
 * of the same replacement gets Stripe's stored answer, not a second session.
 */
function idempotencyKey(session: CheckoutSession): string {
  return `rekey-checkout-fallback-${session.id}-${session.providerSessionId}`;
}

/**
 * Point every local reference from the elements session to its hosted
 * replacement, once. The row moves with one compare-and-set statement that
 * only adds `fallbackUrl` to the metadata, so a refusal counted meanwhile is
 * kept. A concurrent request that lost the race found the same hosted session
 * (same idempotency key) and has nothing to write.
 */
async function rebind(session: SessionWithApp, hosted: { sessionId: string; url: string }): Promise<boolean> {
  const previous = session.providerSessionId;
  return prisma.$transaction(async (tx) => {
    const moved = await tx.$executeRaw`
      UPDATE checkout_sessions
      SET provider_session_id = ${hosted.sessionId},
          metadata = jsonb_set(metadata, '{fallbackUrl}', to_jsonb(${hosted.url}::text)),
          updated_at = NOW()
      WHERE id = ${session.id} AND status = 'OPEN' AND provider_session_id = ${previous}`;
    if (moved === 0) {
      const now = await tx.checkoutSession.findUniqueOrThrow({ where: { id: session.id }, select: { providerSessionId: true } });
      return now.providerSessionId === hosted.sessionId;
    }
    const subscription = await tx.subscription.findUniqueOrThrow({ where: { id: session.subscriptionId }, select: { metadata: true } });
    await tx.subscription.update({
      where: { id: session.subscriptionId },
      data: {
        metadata: buildCheckoutSessionMetadata({
          previous: subscription.metadata,
          sessionId: hosted.sessionId,
          isOneTime: session.kind === 'ONE_TIME',
          coupon: couponForSession(subscription.metadata, previous),
          provider: 'stripe',
          openedAt: new Date(),
        }) as never,
      },
    });
    const where = { applicationId: session.applicationId, checkoutSessionId: previous };
    await tx.couponRedemption.updateMany({ where, data: { checkoutSessionId: hosted.sessionId } });
    await tx.trialRedemption.updateMany({ where, data: { checkoutSessionId: hosted.sessionId } });
    return true;
  });
}

async function issue(session: SessionWithApp, provider: BillingProvider, token: string, log?: FastifyBaseLogger): Promise<string> {
  if (!provider.createHostedFallback) throw unavailable();
  const detail = await prisma.checkoutSession.findUniqueOrThrow({
    where: { id: session.id },
    select: { endUser: true, subscription: { select: { plan: true } } },
  });
  const meta = session.metadata as unknown as EmbeddedSessionMetadata;
  const pageUrl = checkoutPageUrl(session.application.slug, token);

  let hosted: { sessionId: string; url: string };
  try {
    hosted = await provider.createHostedFallback({
      application: { id: session.applicationId, slug: session.application.slug },
      endUser: detail.endUser,
      plan: detail.subscription.plan,
      successUrl: pageUrl,
      cancelUrl: pageUrl,
      ...(meta.trialDays > 0 && { trial: { days: meta.trialDays } }),
      kind: session.kind === 'ONE_TIME' ? 'one_time' : 'recurring',
      embeddedSessionId: session.providerSessionId,
      idempotencyKey: idempotencyKey(session),
      priceId: meta.providerPlanId,
      expiresAt: session.expiresAt,
    });
  } catch (e) {
    if (e instanceof RekeyError) throw e;
    const { code, type } = (e ?? {}) as { code?: unknown; type?: unknown };
    log?.warn({ checkoutSessionId: session.id, stripeCode: code, stripeType: type }, 'stripe hosted fallback failed');
    throw unavailable();
  }
  if (await rebind(session, hosted)) return hosted.url;
  // The row was moved to another session meanwhile, so nothing will ever
  // name this one. Closed so it cannot be paid by anyone holding its URL.
  await provider.expireCheckoutSession?.(hosted.sessionId).catch((e: unknown) => {
    log?.warn({ checkoutSessionId: session.id, orphan: hosted.sessionId, stripeCode: (e as { code?: unknown } | null)?.code }, 'could not expire an unrecorded hosted fallback session');
  });
  throw unavailable();
}

/** The hosted session issued earlier, as Stripe reports it now. */
async function reuse(session: SessionWithApp, provider: BillingProvider): Promise<string> {
  if (!provider.getCheckoutSession) throw unavailable();
  const hosted = await provider.getCheckoutSession(session.providerSessionId).catch(() => null);
  if (hosted?.status === 'complete') throw paidOrProcessing();
  if (hosted === null || hosted.status !== 'open' || hosted.url === null || !hosted.url.startsWith('https://')) {
    throw unavailable();
  }
  return hosted.url;
}

/**
 * The URL for "Continue on Stripe" on this OPEN session: a new hosted session
 * the first time, the same one after. The caller has already settled the
 * session and checked it is OPEN.
 *
 * @example
 * const url = await stripeFallbackUrl(session, 'chk_live_…', req.log);
 */
export async function stripeFallbackUrl(session: SessionWithApp, token: string, log?: FastifyBaseLogger): Promise<string> {
  const provider = await getProviderForApplication(session.application, 'stripe');
  const issued = (session.metadata as unknown as Partial<EmbeddedSessionMetadata>).fallbackUrl != null;
  return issued ? reuse(session, provider) : issue(session, provider, token, log);
}
