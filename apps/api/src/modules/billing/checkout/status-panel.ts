/**
 * The Billing page's status panel for the Rekey checkout page (spec 8.8.5):
 * what is switched on, how the last readiness run went, the last webhook per
 * provider, the last completed Rekey-page checkout per mode, and the recent
 * fallbacks with the check that failed.
 */

import type { CheckoutReadiness, CheckoutReadinessCheck, CheckoutStatusPanel } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';

const FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACKS_SHOWN = 20;

function counts(column: CheckoutReadinessCheck[]): NonNullable<CheckoutStatusPanel['readiness']>['test'] {
  const out = { PASS: 0, WARN: 0, FAIL: 0, 'N/A': 0 };
  for (const check of column) out[check.status]++;
  return out;
}

/**
 * @example
 * const panel = await checkoutStatusPanel(applicationId);
 * panel.fallbackCount; // 3
 */
export async function checkoutStatusPanel(applicationId: string): Promise<CheckoutStatusPanel> {
  const since = new Date(Date.now() - FALLBACK_WINDOW_MS);
  const [app, webhooks, completedTest, completedLive, fallbacks, fallbackCount] = await Promise.all([
    prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { checkoutModeTest: true, checkoutModeLive: true, checkoutFailureMode: true, checkoutReadiness: true },
    }),
    prisma.webhookEvent.groupBy({
      by: ['provider', 'mode'],
      where: { applicationId, mode: { not: null } },
      _max: { receivedAt: true },
    }),
    prisma.checkoutSession.findFirst({
      where: { applicationId, mode: 'EMBEDDED', paymentMode: 'TEST', status: 'COMPLETE' },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
    prisma.checkoutSession.findFirst({
      where: { applicationId, mode: 'EMBEDDED', paymentMode: 'LIVE', status: 'COMPLETE' },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
    prisma.securityEvent.findMany({
      where: { applicationId, type: 'app.checkout_embedded_fallback', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: FALLBACKS_SHOWN,
      select: { createdAt: true, metadata: true },
    }),
    prisma.securityEvent.count({
      where: { applicationId, type: 'app.checkout_embedded_fallback', createdAt: { gte: since } },
    }),
  ]);

  const stored = app.checkoutReadiness as Partial<CheckoutReadiness> | null;
  return {
    settings: {
      checkoutModeTest: app.checkoutModeTest,
      checkoutModeLive: app.checkoutModeLive,
      checkoutFailureMode: app.checkoutFailureMode,
    },
    readiness:
      stored?.test && stored.live && stored.ranAt
        ? { ranAt: stored.ranAt, test: counts(stored.test), live: counts(stored.live) }
        : null,
    lastWebhooks: webhooks
      .filter((w) => w._max.receivedAt !== null)
      .map((w) => ({
        provider: w.provider,
        // The mode the event was verified in, not the credentials' mode now.
        mode: w.mode === 'live' ? ('live' as const) : ('test' as const),
        receivedAt: w._max.receivedAt!.toISOString(),
      })),
    lastEmbeddedCompleted: {
      test: completedTest?.updatedAt.toISOString() ?? null,
      live: completedLive?.updatedAt.toISOString() ?? null,
    },
    recentFallbacks: fallbacks.map((f) => {
      const meta = f.metadata as Record<string, unknown>;
      return {
        at: f.createdAt.toISOString(),
        check: typeof meta.check === 'string' ? meta.check : 'unknown',
        provider: typeof meta.provider === 'string' ? meta.provider : 'unknown',
        paymentMode: typeof meta.paymentMode === 'string' ? meta.paymentMode : 'unknown',
      };
    }),
    fallbackCount,
  };
}
