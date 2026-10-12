/**
 * "Auto-configure webhook", create the provider-side endpoint pointing at our
 * public per-app URL, then persist the returned signing secret (Stripe) or
 * webhook id (PayPal) back into the stored credentials, so the operator never
 * has to paste one out of a dashboard. Idempotent at the provider (it reuses
 * the existing endpoint for the same URL).
 *
 * This lives in its own module rather than on `billingCredentialsService`
 * because it is the one credential operation that needs a *provider instance*.
 * Keeping it here means `credentials.service.ts` (storage) and
 * `providers/index.ts` (construction) no longer import each other, the cycle
 * that previously forced a dynamic import, and with it hid the dependency
 * from module mocking in tests.
 */

import { env } from '../../config/env.js';
import { RekeyError } from '../../lib/error.js';
import { withProviderErrors } from '../../lib/provider-errors.js';
import { applicationsService } from '../applications/applications.service.js';
import {
  billingCredentialsService,
  hasWebhookConfigured,
  type BillingProviderName,
} from './credentials.service.js';
import { getProviderForApplication } from './providers/index.js';
import { getModule } from './providers/registry.js';
import { prisma } from '../../lib/prisma.js';

/**
 * The public URL a provider delivers this Application's webhooks to.
 *
 * @example
 * providerWebhookUrl('paypal', 'acme'); // 'https://api.example.com/api/v1/billing/webhook/paypal/acme'
 */
export function providerWebhookUrl(provider: BillingProviderName, appSlug: string): string {
  const base = (env.PUBLIC_WEBHOOK_BASE_URL ?? env.API_URL).replace(/\/$/, '');
  return `${base}/api/v1/billing/webhook/${provider}/${appSlug}`;
}

export async function registerProviderWebhook(
  applicationId: string,
  provider: BillingProviderName,
  appSlug: string,
): Promise<{ provider: BillingProviderName; webhookConfigured: boolean; url: string }> {
  const base = (env.PUBLIC_WEBHOOK_BASE_URL ?? env.API_URL).replace(/\/$/, '');
  // In production the provider must be able to reach us, a localhost base
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
  // providers whose credentials carry no mode marker, PayPal's `detectMode` is
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
  const url = providerWebhookUrl(provider, appSlug);
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
  // The provider API call can fail for reasons outside our control, most
  // commonly invalid credentials (e.g. PayPal 401 invalid_client), but also
  // rate limits or transient network errors. Surface a clean, actionable
  // error instead of bubbling a raw 500.
  //
  // This route's observable contract is preserved exactly, 502, the
  // established `BILLING_WEBHOOK_REGISTRATION_FAILED` code, and the same
  // `fix`. What changed is that the mapping now goes through the shared
  // helper every other provider call site uses, so there is one place to fix
  // rather than one correct place and six wrong ones.
  const result = await withProviderErrors(
    {
      provider,
      operation: 'webhook registration',
      audience: 'operator',
      code: 'BILLING_WEBHOOK_REGISTRATION_FAILED',
      fix: 'Most often the provider credentials are wrong or for the other mode (e.g. live keys with mode=test). Re-check the API key / client secret + mode, then retry.',
    },
    () => inst.registerWebhook!(url),
  );
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

export type WebhookRefresh = 'unchanged' | 'reconfigured' | 'failed';

/**
 * After a credential edit, point the webhook at the account the new
 * credentials belong to.
 *
 * A stored webhook id or signing secret belongs to the account that issued
 * it. New keys for another account, or the other mode, leave it stored and
 * dead: every inbound event then fails verification. Runs only when a webhook
 * was already set up, the secrets or mode changed, and the edit did not name
 * the webhook field itself (a pasted value, or a blank to clear it). `failed` leaves the stored value alone, and the
 * readiness check and the Reconfigure action take it from there.
 *
 * @example
 * const before = await webhookStateBeforeEdit(appId, 'paypal');
 * await billingCredentialsService.upsertCredentials(appId, 'paypal', data);
 * const webhook = await refreshWebhookAfterEdit(appId, 'paypal', slug, before, data);
 */
export async function refreshWebhookAfterEdit(
  applicationId: string,
  provider: BillingProviderName,
  appSlug: string,
  before: WebhookStateBeforeEdit,
  submitted: Record<string, string | undefined> = {},
): Promise<WebhookRefresh> {
  const module = getModule(provider);
  if (!module?.capabilities.autoWebhookRegister || !before.webhookConfigured) return 'unchanged';
  const webhookField = module.credentialSchema.find((f) => f.webhookRole)?.key;
  if (webhookField !== undefined && submitted[webhookField] !== undefined) return 'unchanged';
  const after = await secretsUpdatedAt(applicationId, provider);
  if (after?.getTime() === before.secretsUpdatedAt?.getTime()) return 'unchanged';
  try {
    await registerProviderWebhook(applicationId, provider, appSlug);
    return 'reconfigured';
  } catch {
    return 'failed';
  }
}

export interface WebhookStateBeforeEdit {
  webhookConfigured: boolean;
  secretsUpdatedAt: Date | null;
}

/** Snapshot taken before a credential edit, for `refreshWebhookAfterEdit`. */
export async function webhookStateBeforeEdit(
  applicationId: string,
  provider: BillingProviderName,
): Promise<WebhookStateBeforeEdit> {
  const stored = await billingCredentialsService.loadDecrypted(applicationId, provider).catch(() => null);
  return {
    webhookConfigured: hasWebhookConfigured(provider, stored),
    secretsUpdatedAt: await secretsUpdatedAt(applicationId, provider),
  };
}

async function secretsUpdatedAt(applicationId: string, provider: BillingProviderName): Promise<Date | null> {
  const row = await prisma.billingCredentials.findUnique({
    where: { applicationId_provider: { applicationId, provider } },
    select: { secretsUpdatedAt: true },
  });
  return row?.secretsUpdatedAt ?? null;
}
