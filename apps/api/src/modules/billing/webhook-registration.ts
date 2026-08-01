/**
 * "Auto-configure webhook" — create the provider-side endpoint pointing at our
 * public per-app URL, then persist the returned signing secret (Stripe) or
 * webhook id (PayPal) back into the stored credentials, so the operator never
 * has to paste one out of a dashboard. Idempotent at the provider (it reuses
 * the existing endpoint for the same URL).
 *
 * This lives in its own module rather than on `billingCredentialsService`
 * because it is the one credential operation that needs a *provider instance*.
 * Keeping it here means `credentials.service.ts` (storage) and
 * `providers/index.ts` (construction) no longer import each other — the cycle
 * that previously forced a dynamic import, and with it hid the dependency
 * from module mocking in tests.
 */

import { env } from '../../config/env.js';
import { RekeyError } from '../../lib/error.js';
import { applicationsService } from '../applications/applications.service.js';
import {
  billingCredentialsService,
  hasWebhookConfigured,
  type BillingProviderName,
} from './credentials.service.js';
import { getProviderForApplication } from './providers/index.js';

export async function registerProviderWebhook(
  applicationId: string,
  provider: BillingProviderName,
  appSlug: string,
): Promise<{ provider: BillingProviderName; webhookConfigured: boolean; url: string }> {
  const base = (env.PUBLIC_WEBHOOK_BASE_URL ?? env.API_URL).replace(/\/$/, '');
  // In production the provider must be able to reach us — a localhost base
  // would register a dead endpoint. In dev/test we allow it (an
  // operator-supplied ngrok tunnel, or a fake provider under test).
  if (env.NODE_ENV === 'production' && /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(base)) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_WEBHOOK_BASE_NOT_PUBLIC',
      message: `Webhook auto-config needs a public URL, but the base is "${base}".`,
      fix: 'Set PUBLIC_WEBHOOK_BASE_URL to your internet-reachable API origin, then retry.',
    });
  }
  // Load the row's stored mode, not just its data: the re-save at the end of
  // this function has to preserve it verbatim. Re-deriving would be wrong for
  // providers whose credentials carry no mode marker — PayPal's `detectMode` is
  // absent by design, so a re-derive falls back to 'test' and would silently
  // relabel a live PayPal row. That is not cosmetic: `mode` is what picks
  // PayPal's sandbox-vs-live base URL and what the panel and revenue stats read
  // to decide whether an amount is real money, and it would flip as a
  // side-effect of registering a webhook.
  const stored = await billingCredentialsService.loadDecryptedWithMode(applicationId, provider);
  const current = stored?.data ?? null;
  if (!current) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
      message: `Configure ${provider} credentials before auto-registering its webhook.`,
      fix: `Save the ${provider} API keys first, then auto-configure the webhook.`,
    });
  }
  const url = `${base}/api/v1/billing/webhook/${provider}/${appSlug}`;
  const application = await applicationsService.get(applicationId);
  const inst = await getProviderForApplication(application, provider);
  if (!inst.registerWebhook) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_WEBHOOK_AUTOCONFIG_UNSUPPORTED',
      message: `Automatic webhook configuration isn't supported for "${provider}".`,
      fix: 'Configure the webhook manually in the provider dashboard, then paste the secret/id.',
    });
  }
  // The provider API call can fail for reasons outside our control — most
  // commonly invalid credentials (e.g. PayPal 401 invalid_client), but also
  // rate limits or transient network errors. Surface a clean, actionable
  // error instead of bubbling a raw 500.
  let result: { secret?: string; webhookId?: string };
  try {
    result = await inst.registerWebhook(url);
  } catch (e) {
    throw new RekeyError({
      statusCode: 502,
      code: 'BILLING_WEBHOOK_REGISTRATION_FAILED',
      message: `The ${provider} API rejected webhook registration: ${(e as Error).message}`,
      fix: 'Most often the provider credentials are wrong or for the other mode (e.g. live keys with mode=test). Re-check the API key / client secret + mode, then retry.',
    });
  }
  const merged = {
    ...current,
    ...(result.secret !== undefined && { webhookSecret: result.secret }),
    ...(result.webhookId !== undefined && { webhookId: result.webhookId }),
  };
  await billingCredentialsService.upsertRaw(applicationId, provider, merged, {
    mode: stored!.mode,
  });
  return { provider, webhookConfigured: hasWebhookConfigured(provider, merged), url };
}
