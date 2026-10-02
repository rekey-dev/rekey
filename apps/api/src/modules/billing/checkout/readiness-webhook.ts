/**
 * Readiness check 3, the provider's webhook: registered, and delivering
 * events verified with the current credentials.
 */

import type { CheckoutReadinessCheck } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { env } from '../../../config/env.js';
import { hasWebhookConfigured, type BillingMode, type BillingProviderName } from '../credentials.service.js';
import { razorpayOrderPaidCheck, razorpayWebhookFix } from './razorpay-readiness.js';
import { label, modeWord, pass, type Kind } from './readiness-shared.js';

type Check = CheckoutReadinessCheck;

const WEBHOOK_LOOKBACK_DAYS = 30;
const WEBHOOK_STALE_DAYS = 7;
/** The receipt note the webhook pipeline records for a mode-mismatch refusal. */
const MODE_MISMATCH_PREFIX = 'WEBHOOK_MODE_MISMATCH';
const DAY_MS = 24 * 60 * 60 * 1000;

/** When this provider's secret or mode last changed; null when none is stored. */
export async function secretsSavedAt(applicationId: string, provider: BillingProviderName): Promise<Date | null> {
  const credential = await prisma.billingCredentials.findUnique({
    where: { applicationId_provider: { applicationId, provider } },
    select: { secretsUpdatedAt: true },
  });
  return credential?.secretsUpdatedAt ?? null;
}

/** The newest webhook verified with this mode's credentials since they were saved, within the lookback. */
export async function latestVerifiedWebhook(
  applicationId: string,
  provider: BillingProviderName,
  mode: BillingMode,
): Promise<{ receivedAt: Date | null; lookbackDays: number }> {
  const lookbackDays =
    env.WEBHOOK_EVENT_RETENTION_DAYS > 0 ? Math.min(WEBHOOK_LOOKBACK_DAYS, env.WEBHOOK_EVENT_RETENTION_DAYS) : WEBHOOK_LOOKBACK_DAYS;
  // Only events verified with THIS mode's credentials, and only since their
  // secret or mode last changed: a sandbox delivery proves nothing about the
  // live webhook, and neither does an event verified with credentials since
  // replaced. An enable or routing edit does not restart the window.
  const savedAt = await secretsSavedAt(applicationId, provider);
  const since = new Date(Math.max(Date.now() - lookbackDays * DAY_MS, savedAt?.getTime() ?? 0));
  // A mode-mismatch refusal proves the webhook is wired to the other mode.
  // Matched by code, not by `processedAt`: an event that verified and then
  // failed to apply still proves delivery.
  const latest = await prisma.webhookEvent.findFirst({
    where: {
      applicationId,
      provider,
      mode,
      receivedAt: { gte: since },
      OR: [{ processingError: null }, { NOT: { processingError: { startsWith: MODE_MISMATCH_PREFIX } } }],
    },
    orderBy: { receivedAt: 'desc' },
    select: { receivedAt: true },
  });
  return { receivedAt: latest?.receivedAt ?? null, lookbackDays };
}

/**
 * Check 3: a webhook is registered and, in live mode, has delivered a verified
 * event. `kinds` is what the Application sells, which decides whether
 * Razorpay's `order.paid` must have been seen.
 *
 * @example
 * const check = await webhookCheck(appId, 'razorpay', 'live', creds, new Set(['one_time']));
 */
export async function webhookCheck(
  applicationId: string,
  provider: BillingProviderName,
  mode: BillingMode,
  creds: unknown,
  kinds: ReadonlySet<Kind>,
): Promise<Check> {
  const where = `Panel → Application → Billing → Setup → Providers → ${label(provider)}`;
  if (!hasWebhookConfigured(provider, creds)) {
    return {
      id: 'webhook',
      provider,
      status: 'FAIL',
      message: `No ${label(provider)} webhook is registered, and purchases complete only from the provider's webhook.`,
      fix: provider === 'razorpay' ? razorpayWebhookFix(where) : `Register the webhook in ${where} (Auto-configure, or paste its id in Edit).`,
    };
  }
  const { receivedAt: latest, lookbackDays } = await latestVerifiedWebhook(applicationId, provider, mode);
  const firstPurchase =
    mode === 'live'
      ? `complete one checkout on the provider's page so an event arrives`
      : `complete one sandbox checkout (on the provider's page or on the Rekey page) so an event arrives`;
  if (latest === null) {
    return {
      id: 'webhook',
      provider,
      status: mode === 'live' ? 'FAIL' : 'WARN',
      message: `${label(provider)} has not delivered a webhook verified with these ${modeWord(mode)} credentials in the last ${lookbackDays} days, or since they were last saved.`,
      fix: `Check the webhook in ${where}, then ${firstPurchase}.`,
    };
  }
  if (latest.getTime() < Date.now() - WEBHOOK_STALE_DAYS * DAY_MS) {
    return {
      id: 'webhook',
      provider,
      status: 'WARN',
      message: `The last verified ${label(provider)} webhook arrived on ${latest.toISOString().slice(0, 10)}.`,
      fix: `Check that the webhook in ${where} is still active at ${label(provider)}.`,
    };
  }
  if (provider === 'razorpay' && kinds.has('one_time')) {
    const orderPaid = await razorpayOrderPaidCheck(applicationId, mode);
    if (orderPaid) return orderPaid;
  }
  return pass('webhook', provider, `${label(provider)} delivered a verified webhook on ${latest.toISOString().slice(0, 10)}.`);
}
