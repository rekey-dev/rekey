/**
 * Per-Application, per-provider billing credentials.
 *
 * Multi-provider model (phase 6+): an Application can have any subset of
 * {stripe, paypal, razorpay} configured concurrently. Each row of the
 * `billing_credentials` table is one provider's BYO secrets, AES-256-GCM
 * encrypted via lib/secrets.ts.
 *
 * **Reads decrypt; never expose ciphertext or plaintext on any HTTP
 * response.** The route layer returns only `{provider, configured, enabled,
 * countries, priority}` shapes — see `statusList` below.
 *
 * Provider-specific credential shapes:
 *   stripe   → { apiKey: 'sk_live_…', webhookSecret: 'whsec_…' }
 *   paypal   → { clientId, clientSecret, webhookId }
 *   razorpay → { keyId, keySecret, webhookSecret }
 *
 * Backwards-compat: rows backfilled from the legacy
 * `applications.billing_credentials_ciphertext` column store the *wrapped*
 * `{provider, data}` shape (because that's what the old codepath encrypted).
 * `loadDecrypted` accepts both — wrapped and unwrapped — and unwraps
 * transparently. New writes encrypt only the inner `data`.
 */

import { prisma } from '../../lib/prisma.js';
import { encryptJson, decryptJson } from '../../lib/secrets.js';
import { RelipayError } from '../../lib/error.js';
import { env } from '../../config/env.js';
import { applicationsService } from '../applications/applications.service.js';

export type BillingProviderName = 'stripe' | 'paypal' | 'razorpay';

export type StripeCredentials = {
  apiKey: string;
  webhookSecret: string;
};

export type PaypalCredentials = {
  clientId: string;
  clientSecret: string;
  webhookId: string;
};

export type RazorpayCredentials = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
};

export type CredentialsByProvider = {
  stripe: StripeCredentials;
  paypal: PaypalCredentials;
  razorpay: RazorpayCredentials;
};

export type BillingMode = 'test' | 'live';

export interface CredentialsStatus {
  provider: BillingProviderName;
  configured: boolean;
  enabled: boolean;
  mode: BillingMode;
  countries: string[];
  priority: number;
  /** Whether the provider webhook secret/id is set (manually or auto-registered). */
  webhookConfigured: boolean;
}

/** Does this provider's decrypted creds carry the webhook secret/id it needs? */
function hasWebhookConfigured(provider: BillingProviderName, data: unknown): boolean {
  const d = (data ?? {}) as Record<string, unknown>;
  if (provider === 'paypal') return typeof d.webhookId === 'string' && d.webhookId.length > 0;
  return typeof d.webhookSecret === 'string' && (d.webhookSecret as string).length > 0;
}

/**
 * Best-effort mode inference from key shapes:
 *   - Stripe: `sk_live_` / `sk_test_`
 *   - Razorpay: `rzp_live_` / `rzp_test_`
 *   - PayPal: no shape distinction, defaults to 'test' unless caller overrides.
 *
 * Operators can always override with `options.mode` at upsert time.
 */
function inferMode(provider: BillingProviderName, data: unknown): 'test' | 'live' {
  if (provider === 'stripe') {
    const key = (data as { apiKey?: string }).apiKey ?? '';
    return key.startsWith('sk_live_') ? 'live' : 'test';
  }
  if (provider === 'razorpay') {
    const key = (data as { keyId?: string }).keyId ?? '';
    return key.startsWith('rzp_live_') ? 'live' : 'test';
  }
  return 'test';
}

function unwrap<P extends BillingProviderName>(
  ciphertext: string,
  expected: P,
): CredentialsByProvider[P] {
  let decrypted: unknown;
  try {
    decrypted = decryptJson<unknown>(ciphertext);
  } catch (e) {
    // Bad ciphertext means either (a) the encryption key rotated and this
    // row predates the new one, or (b) the row is corrupted. Either way
    // we cannot safely fall through to a billing call — refuse with a
    // 500-class error that points operators at the re-enter path.
    throw new RelipayError({
      statusCode: 500,
      code: 'BILLING_CREDENTIALS_DECRYPT_FAILED',
      message: `Stored credentials for "${expected}" cannot be decrypted: ${(e as Error).message}`,
      fix: 'Re-enter credentials via PUT /tenant/applications/:id/billing-credentials/:provider.',
    });
  }
  if (decrypted === null || typeof decrypted !== 'object') {
    throw new RelipayError({
      statusCode: 500,
      code: 'BILLING_CREDENTIALS_SHAPE_INVALID',
      message: `Stored credentials for "${expected}" decrypted to a non-object — corruption suspected.`,
      fix: 'Re-enter credentials via PUT /tenant/applications/:id/billing-credentials/:provider.',
    });
  }
  // Legacy wrapped shape: { provider, data } — unwrap.
  if ('provider' in decrypted && 'data' in decrypted) {
    const w = decrypted as { provider: string; data: unknown };
    if (w.provider !== expected) {
      throw new RelipayError({
        statusCode: 500,
        code: 'BILLING_CREDENTIALS_PROVIDER_MISMATCH',
        message: `Stored credentials are for "${w.provider}" but row is keyed under "${expected}".`,
        fix: 'Re-enter credentials via PUT /tenant/applications/:id/billing-credentials/:provider.',
      });
    }
    return w.data as CredentialsByProvider[P];
  }
  // New shape: just the inner data object.
  return decrypted as CredentialsByProvider[P];
}

export const billingCredentialsService = {
  async list(applicationId: string): Promise<CredentialsStatus[]> {
    const rows = await prisma.billingCredentials.findMany({
      where: { applicationId },
      orderBy: { priority: 'asc' },
    });
    return rows.map((r) => {
      let webhookConfigured = false;
      try {
        webhookConfigured = hasWebhookConfigured(
          r.provider as BillingProviderName,
          unwrap(r.ciphertext, r.provider as BillingProviderName),
        );
      } catch {
        // Undecryptable row (rotated key / corruption) — surface as not
        // configured rather than failing the whole list.
        webhookConfigured = false;
      }
      return {
        provider: r.provider as BillingProviderName,
        configured: true,
        enabled: r.enabled,
        mode: (r.mode === 'live' ? 'live' : 'test') as BillingMode,
        countries: r.countries,
        priority: r.priority,
        webhookConfigured,
      };
    });
  },

  /**
   * Decrypt credentials and return the row's `mode`. Used by provider
   * factories that need to know whether to point at sandbox or live URLs
   * (PayPal, in particular, has different base URLs per mode).
   */
  async loadDecryptedWithMode<P extends BillingProviderName>(
    applicationId: string,
    provider: P,
  ): Promise<{ data: CredentialsByProvider[P]; mode: BillingMode } | null> {
    const row = await prisma.billingCredentials.findUnique({
      where: { applicationId_provider: { applicationId, provider } },
    });
    if (!row) return null;
    return {
      data: unwrap(row.ciphertext, provider),
      mode: (row.mode === 'live' ? 'live' : 'test') as BillingMode,
    };
  },

  /**
   * Decrypt and return one provider's credentials, or null if not configured.
   * Result must not leave the server.
   */
  async loadDecrypted<P extends BillingProviderName>(
    applicationId: string,
    provider: P,
  ): Promise<CredentialsByProvider[P] | null> {
    const row = await prisma.billingCredentials.findUnique({
      where: { applicationId_provider: { applicationId, provider } },
    });
    if (!row) return null;
    return unwrap(row.ciphertext, provider);
  },

  /**
   * Return all enabled providers, sorted for "best for this country first".
   * Always returns *every* enabled provider — the country argument only
   * affects ordering, not filtering. The /providers listing surface and the
   * pickProvider geo-router both read from here:
   *
   *   - /providers UI: shows the full picker; country-matching ones float to
   *     the top so the IN user sees Razorpay first but PayPal still appears.
   *   - pickProvider: applies stricter rules on top (country-restricted
   *     providers don't auto-pick for non-matching countries).
   *
   * Sort order:
   *   1. Country-specific match (countries[] contains country) — by priority.
   *   2. Global / fallback (countries[] empty) — by priority.
   *   3. Other country-restricted that don't match — by priority.
   */
  async listEnabled(
    applicationId: string,
    country?: string,
  ): Promise<{ provider: BillingProviderName; priority: number; countries: string[]; mode: BillingMode }[]> {
    const rows = await prisma.billingCredentials.findMany({
      where: { applicationId, enabled: true },
      orderBy: { priority: 'asc' },
      select: { provider: true, priority: true, countries: true, mode: true },
    });
    const upper = country?.toUpperCase();
    const score = (r: { countries: string[] }): number => {
      if (upper && r.countries.includes(upper)) return 0;
      if (r.countries.length === 0) return 1;
      return 2;
    };
    return rows
      .map((r) => ({
        provider: r.provider as BillingProviderName,
        priority: r.priority,
        countries: r.countries,
        mode: (r.mode === 'live' ? 'live' : 'test') as BillingMode,
        _s: score(r),
      }))
      .sort((a, b) => a._s - b._s || a.priority - b.priority)
      .map(({ _s: _, ...rest }) => rest);
  },

  async upsertStripe(
    applicationId: string,
    data: StripeCredentials,
    options?: { countries?: string[]; priority?: number; enabled?: boolean; mode?: BillingMode },
  ): Promise<void> {
    if (!data.apiKey.startsWith('sk_')) {
      throw new RelipayError({
        statusCode: 400,
        code: 'BILLING_CREDENTIALS_INVALID',
        message: 'Stripe `apiKey` must start with `sk_` (live or test).',
        fix: 'Get a secret key from Stripe Dashboard → Developers → API keys.',
      });
    }
    // webhookSecret is optional now — operators can leave it blank and click
    // "Auto-configure webhook" (registerWebhook) to have ReliPay create the
    // endpoint via the Stripe API and store the signing secret. If supplied
    // manually it must still be a valid signing secret.
    if (data.webhookSecret && !data.webhookSecret.startsWith('whsec_')) {
      throw new RelipayError({
        statusCode: 400,
        code: 'BILLING_CREDENTIALS_INVALID',
        message: 'Stripe `webhookSecret`, when provided, must start with `whsec_`.',
        fix: 'Leave it blank to auto-configure, or paste the signing secret from Stripe → Developers → Webhooks.',
      });
    }
    await this.upsertRaw(applicationId, 'stripe', data, options);
  },

  async upsertPaypal(
    applicationId: string,
    data: PaypalCredentials,
    options?: { countries?: string[]; priority?: number; enabled?: boolean; mode?: BillingMode },
  ): Promise<void> {
    // webhookId is optional now — leave blank and click "Auto-configure
    // webhook" to have ReliPay create the PayPal webhook via API and store
    // its id. clientId + clientSecret are always required.
    if (!data.clientId || !data.clientSecret) {
      throw new RelipayError({
        statusCode: 400,
        code: 'BILLING_CREDENTIALS_INVALID',
        message: 'PayPal credentials require `clientId` and `clientSecret`.',
        fix: 'Get these from PayPal Developer Dashboard → Apps & Credentials.',
      });
    }
    await this.upsertRaw(applicationId, 'paypal', data, options);
  },

  async upsertRazorpay(
    applicationId: string,
    data: RazorpayCredentials,
    options?: { countries?: string[]; priority?: number; enabled?: boolean; mode?: BillingMode },
  ): Promise<void> {
    if (!data.keyId.startsWith('rzp_')) {
      throw new RelipayError({
        statusCode: 400,
        code: 'BILLING_CREDENTIALS_INVALID',
        message: 'Razorpay `keyId` must start with `rzp_` (live or test).',
        fix: 'Get keys from Razorpay Dashboard → Settings → API Keys.',
      });
    }
    if (!data.keySecret || !data.webhookSecret) {
      throw new RelipayError({
        statusCode: 400,
        code: 'BILLING_CREDENTIALS_INVALID',
        message: 'Razorpay credentials require `keyId`, `keySecret`, and `webhookSecret`.',
        fix: 'Get these from Razorpay Dashboard → Settings.',
      });
    }
    await this.upsertRaw(applicationId, 'razorpay', data, options);
  },

  async upsertRaw(
    applicationId: string,
    provider: BillingProviderName,
    data: unknown,
    options?: { countries?: string[]; priority?: number; enabled?: boolean; mode?: BillingMode },
  ): Promise<void> {
    const ciphertext = encryptJson(data);
    const countries = (options?.countries ?? []).map((c) => c.toUpperCase().trim()).filter(Boolean);
    const mode = options?.mode ?? inferMode(provider, data);
    await prisma.billingCredentials.upsert({
      where: { applicationId_provider: { applicationId, provider } },
      create: {
        applicationId,
        provider,
        ciphertext,
        countries,
        priority: options?.priority ?? 100,
        enabled: options?.enabled ?? true,
        mode,
      },
      update: {
        ciphertext,
        mode,
        ...(options?.countries !== undefined && { countries }),
        ...(options?.priority !== undefined && { priority: options.priority }),
        ...(options?.enabled !== undefined && { enabled: options.enabled }),
      },
    });
  },

  /**
   * Auto-configure the provider's webhook via its API: create the endpoint at
   * our public per-app URL, then persist the returned signing secret (Stripe)
   * / webhook id (PayPal) back into the stored credentials — removing the
   * manual dashboard paste. Idempotent at the provider (reuses the existing
   * endpoint for the same URL).
   */
  async registerWebhook(
    applicationId: string,
    provider: BillingProviderName,
    appSlug: string,
  ): Promise<{ provider: BillingProviderName; webhookConfigured: boolean; url: string }> {
    const base = (env.PUBLIC_WEBHOOK_BASE_URL ?? env.API_URL).replace(/\/$/, '');
    // In production the provider must be able to reach us — a localhost base
    // would register a dead endpoint. In dev/test we allow it (stub provider,
    // or operator-supplied ngrok tunnel).
    if (env.NODE_ENV === 'production' && /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(base)) {
      throw new RelipayError({
        statusCode: 400,
        code: 'BILLING_WEBHOOK_BASE_NOT_PUBLIC',
        message: `Webhook auto-config needs a public URL, but the base is "${base}".`,
        fix: 'Set PUBLIC_WEBHOOK_BASE_URL to your internet-reachable API origin, then retry.',
      });
    }
    const current = await this.loadDecrypted(applicationId, provider);
    if (!current) {
      throw new RelipayError({
        statusCode: 400,
        code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
        message: `Configure ${provider} credentials before auto-registering its webhook.`,
        fix: `Save the ${provider} API keys first, then auto-configure the webhook.`,
      });
    }
    const url = `${base}/api/v1/billing/webhook/${provider}/${appSlug}`;
    const application = await applicationsService.get(applicationId);
    // Dynamic import breaks the providers/index ↔ credentials.service cycle.
    const { getProviderForApplication } = await import('./providers/index.js');
    const inst = await getProviderForApplication(application, provider);
    if (!inst.registerWebhook) {
      throw new RelipayError({
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
      throw new RelipayError({
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
    await this.upsertRaw(applicationId, provider, merged);
    return { provider, webhookConfigured: hasWebhookConfigured(provider, merged), url };
  },

  async setEnabled(
    applicationId: string,
    provider: BillingProviderName,
    enabled: boolean,
  ): Promise<void> {
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId, provider } },
      data: { enabled },
    });
  },

  async setMode(
    applicationId: string,
    provider: BillingProviderName,
    mode: BillingMode,
  ): Promise<void> {
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId, provider } },
      data: { mode },
    });
  },

  async setRouting(
    applicationId: string,
    provider: BillingProviderName,
    countries: string[],
    priority: number,
  ): Promise<void> {
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId, provider } },
      data: {
        countries: countries.map((c) => c.toUpperCase().trim()).filter(Boolean),
        priority,
      },
    });
  },

  async remove(applicationId: string, provider: BillingProviderName): Promise<void> {
    await prisma.billingCredentials.delete({
      where: { applicationId_provider: { applicationId, provider } },
    });
  },
};
