/**
 * Per-Application, per-provider billing credentials.
 *
 * Multi-provider model (phase 6+): an Application can have any subset of
 * {stripe, paypal, razorpay} configured concurrently. Each row of the
 * `billing_credentials` table is one provider's BYO secrets, AES-256-GCM
 * encrypted via lib/secrets.ts.
 *
 * **Reads decrypt; never expose ciphertext or plaintext on any HTTP
 * response.** The route layer returns only `CredentialsStatus` shapes,
 * `{provider, configured, enabled, mode, countries, priority, webhookConfigured}`,
 * see `list` below.
 *
 * Credential shapes are declared by each provider module's
 * `credentialSchema` (providers/modules/<name>/), and this service is
 * generic over them (P3): validation, mode detection, and the
 * webhook-configured check all derive from the registry. The stored JSON
 * keys are pinned by the registry-integrity test, zero data migration:
 *   stripe   → { apiKey: 'sk_live_…', webhookSecret: 'whsec_…' }
 *   paypal   → { clientId, clientSecret, webhookId }
 *   razorpay → { keyId, keySecret, webhookSecret }
 *   external → { webhookSecret }
 *
 * Backwards-compat: rows backfilled from the legacy
 * `applications.billing_credentials_ciphertext` column store the *wrapped*
 * `{provider, data}` shape (because that's what the old codepath encrypted).
 * `loadDecrypted` accepts both, wrapped and unwrapped, and unwraps
 * transparently. New writes encrypt only the inner `data`.
 *
 * The unwrap is KEPT deliberately (reviewed for removal in 2.0.0): the blobs
 * are ENCRYPTION_KEY-encrypted so no SQL migration can rewrite them, and
 * without it a wrapped row yields `{provider, data}` where `{apiKey, …}` is
 * expected, the provider SDK would then authenticate with `undefined` and
 * the operator's money path would fail at the processor, not here.
 */

import { isSellableCurrency } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { encryptJson, decryptJson } from '../../lib/secrets.js';
import { RekeyError } from '../../lib/error.js';
import { recordBillingEvent } from '../billing-log/index.js';
import { getModule, credentialRulesSchema } from './providers/registry.js';
import type { ProviderModule } from './providers/module-types.js';

export type BillingProviderName = 'stripe' | 'paypal' | 'razorpay' | 'external';

/**
 * Typed handles on the built-in credential shapes. The *authoritative*
 * declaration is each module's `credentialSchema` (that is what validates and
 * what the registry-integrity test pins); these exist so the `Real*Provider`
 * constructors take something better than `Record<string, string>`. Not
 * deprecated, the deprecated `upsertStripe`/`upsertPaypal`/`upsertRazorpay`
 * wrappers that once paired with them were removed in 2.0.0.
 */
export type StripeCredentials = {
  apiKey: string;
  webhookSecret: string;
  /** Optional, for the Rekey checkout page only; blank on rows saved before it existed. */
  publishableKey?: string;
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

/** The external billing system holds one secret: what it signs events with. */
export type ExternalCredentials = {
  webhookSecret: string;
};

export type CredentialsByProvider = {
  stripe: StripeCredentials;
  paypal: PaypalCredentials;
  razorpay: RazorpayCredentials;
  external: ExternalCredentials;
};

export type BillingMode = 'test' | 'live';

/**
 * Credential mode (`test` | `live`) is descriptive, not a permission.
 *
 * It is NOT constrained by the Application's environment. An operator may
 * store live credentials against a DEVELOPMENT Application if that is what
 * they want to do, deliberately testing against a live processor is a real
 * workflow, and it is their processor account and their customers.
 *
 * We tried the opposite (a PRODUCTION-only-live / non-production-only-test
 * rule) and removed it, because it could only ever be enforced for two of the
 * three providers: PayPal sandbox and live client ids are byte-identical, so
 * nothing here can tell them apart. A safety property that silently does not
 * apply to one provider is worse than no property, because operators
 * generalise from the two where it does.
 *
 * What we DO enforce is that the stored mode is not a lie, see `resolveMode`.
 * Where the key states its own mode (Stripe `sk_live_`/`sk_test_`, Razorpay
 * `rzp_live_`/`rzp_test_`) that is what gets stored, because the provider SDK
 * reads the key and ignores this column: a live key labelled `test` would make
 * the panel, the revenue stats and dunning all report something false about
 * the operator's own money. Where the key cannot say (PayPal), the operator's
 * declaration is taken as given.
 *
 * Abuse of non-production Applications is a quota/rate-limit problem, handled
 * on that axis rather than by refusing credentials.
 */

export interface CredentialsStatus {
  provider: BillingProviderName;
  configured: boolean;
  enabled: boolean;
  mode: BillingMode;
  countries: string[];
  priority: number;
  /** Currencies this account can charge, upper-case. Empty means none. */
  currencies: string[];
  /**
   * The stored currencies this provider cannot charge at all: saved before
   * the list was checked on save. Routing skips them.
   */
  unsupportedCurrencies: string[];
  /** Whether the provider webhook secret/id is set (manually or auto-registered). */
  webhookConfigured: boolean;
}

export interface EnabledProvider {
  provider: BillingProviderName;
  priority: number;
  countries: string[];
  /** Upper-case. Empty means none: the provider is not used for any checkout. */
  currencies: string[];
  /** The stored currencies this provider cannot charge at all. `canCharge` skips them. */
  unsupportedCurrencies: string[];
  mode: BillingMode;
}

interface CredentialOptions {
  countries?: string[];
  currencies?: string[];
  priority?: number;
  enabled?: boolean;
  mode?: BillingMode;
  /** The operator saving the row, named in the billing log when the currency list changes. */
  operatorId?: string;
}

type Tx = Parameters<typeof recordBillingEvent>[0];

function sameCurrencies(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * Write `provider.currencies_changed` in the transaction that saved the list.
 * A save that leaves the same currencies writes nothing.
 */
async function recordCurrenciesChange(
  tx: Tx,
  args: { applicationId: string; provider: string; before: readonly string[]; after: readonly string[]; operatorId: string | undefined },
): Promise<void> {
  if (sameCurrencies(args.before, args.after)) return;
  await recordBillingEvent(tx, {
    type: 'provider.currencies_changed',
    applicationId: args.applicationId,
    actor: args.operatorId === undefined ? { type: 'system' } : { type: 'operator', id: args.operatorId },
    provider: args.provider,
    data: { before: [...args.before], after: [...args.after] },
  });
}

/**
 * Whether a provider can charge a currency at all, by its module's published
 * list. A provider with no registered module is not judged.
 *
 * @example
 * providerSupportsCurrency('paypal', 'INR'); // false
 */
export function providerSupportsCurrency(provider: string, currency: string): boolean {
  const supported = getModule(provider)?.display.supportedCurrencies;
  if (supported === undefined) return true;
  const code = currency.toUpperCase();
  return supported === 'all-sellable' ? isSellableCurrency(code) : supported.includes(code);
}

/**
 * The stored currencies a provider cannot charge at all, in the order stored.
 *
 * @example
 * unsupportedCurrenciesOf('paypal', ['USD', 'INR']); // ['INR']
 */
export function unsupportedCurrenciesOf(provider: string, currencies: readonly string[]): string[] {
  return currencies.filter((code) => !providerSupportsCurrency(provider, code));
}

/**
 * The currency list to store for a provider: upper-case, no repeats. Refuses
 * a code the provider cannot charge at all, so a price in it is never
 * promised to a buyer.
 */
function normaliseCurrencies(provider: string, currencies: string[]): string[] {
  const codes = [...new Set(currencies.map((c) => c.toUpperCase().trim()).filter(Boolean))];
  const unsupported = unsupportedCurrenciesOf(provider, codes);
  if (unsupported.length > 0) {
    const label = getModule(provider)?.display.label ?? provider;
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_PROVIDER_CURRENCY_NOT_OFFERED',
      message: `${label} ("${provider}") cannot charge ${unsupported.join(', ')}.`,
      fix: `Remove ${unsupported.join(', ')} from \`currencies\` and save again. GET /api/v1/tenant/applications/:id/billing/providers lists what each provider can charge in \`supportedCurrencies\`.`,
    });
  }
  return codes;
}

/**
 * Whether a provider account can charge a currency, by the operator's own
 * declaration. An empty list means none. A stored code the provider cannot
 * charge at all is never chargeable.
 *
 * @example
 * canCharge({ currencies: ['INR'] }, 'usd'); // false
 * canCharge({ currencies: [] }, 'usd'); // false
 * canCharge({ currencies: ['INR', 'USD'], unsupportedCurrencies: ['INR'] }, 'inr'); // false
 */
export function canCharge(
  provider: { currencies: string[]; unsupportedCurrencies?: readonly string[] | undefined },
  currency: string,
): boolean {
  const code = currency.toUpperCase();
  if (provider.unsupportedCurrencies?.includes(code)) return false;
  return provider.currencies.includes(code);
}

/**
 * The currencies a new credential row starts with when its caller names
 * none: what the module says an account usually charges. Without it a row
 * saved with no list would charge nothing.
 *
 * @example
 * currenciesForNewRow('razorpay'); // ['INR']
 */
export function currenciesForNewRow(provider: string): string[] {
  return [...(getModule(provider)?.display.preselectedCurrencies ?? [])];
}

function defaultPriority(provider: string): number {
  return getModule(provider)?.display.priority ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Does this provider's decrypted creds carry the webhook secret/id it needs?
 * Registry-driven: reads the module's single `webhookRole` field (Stripe /
 * Razorpay declare `webhookSecret`, PayPal `webhookId`, same checks the
 * hand-written version made). A provider without a registered module or a
 * `webhookRole` field can never verify inbound webhooks → false.
 */
export function hasWebhookConfigured(provider: BillingProviderName, data: unknown): boolean {
  const field = getModule(provider)?.credentialSchema.find((f) => f.webhookRole);
  if (!field) return false;
  const v = ((data ?? {}) as Record<string, unknown>)[field.key];
  return typeof v === 'string' && v.length > 0;
}

/**
 * Read the mode out of the key material, when the provider's credentials say
 * so. `null` means "this provider's credentials carry no marker, or the shape
 * is unrecognised", see `ProviderModule.detectMode`.
 */
function detectMode(provider: BillingProviderName, data: unknown): BillingMode | null {
  return getModule(provider)?.detectMode?.((data ?? {}) as Record<string, string>) ?? null;
}

/**
 * Decide the mode a credential row is stored under.
 *
 * **The key wins over the label.** If the credential material states its own
 * mode, that is what we store, and a contradicting `options.mode` is a hard
 * refusal rather than a silent override. This is the whole load-bearing point:
 * the provider SDK authenticates with the *key*, never with our label, so a
 * `mode: 'test'` sticker on an `sk_live_…` key would leave the panel's badge,
 * the revenue stats and dunning all reporting a real Stripe account as
 * sandbox. Refusing is also strictly more useful than silently correcting, an
 * operator who typed the wrong one wants to know.
 *
 * Note the scope of that: `mode` records what the key IS, it does not decide
 * what the key is ALLOWED to be. The Application's environment does not
 * constrain it (see the header comment above).
 *
 * An explicit label only decides when detection is structurally impossible
 * (PayPal: a sandbox client id is byte-indistinguishable from a live one).
 * With neither, we store `test`, least privilege, and the reading that
 * understates rather than overstates what a figure means.
 */
function resolveMode(
  provider: BillingProviderName,
  data: unknown,
  requested: BillingMode | undefined,
): BillingMode {
  const detected = detectMode(provider, data);
  if (detected === null) return requested ?? 'test';
  if (requested !== undefined && requested !== detected) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_CREDENTIALS_MODE_CONTRADICTED',
      message: `These ${provider} credentials are ${detected} credentials, but they were submitted as \`mode: ${requested}\`.`,
      fix: `The key itself decides: ${provider} keys state their mode, and the provider SDK reads the key, not the label. Submit the ${requested} credentials, or drop \`mode\` and let it be read from the key.`,
    });
  }
  return detected;
}

/** Resolve a registered module or 400, providers only exist via the registry. */
function requireModule(provider: string): ProviderModule {
  const module = getModule(provider);
  if (!module) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_PROVIDER_UNKNOWN',
      message: `"${provider}" is not a registered billing provider.`,
      fix: 'Use one of the registered providers (see GET /api/v1/tenant/applications/:id/billing-credentials).',
    });
  }
  return module;
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
    // we cannot safely fall through to a billing call, refuse with a
    // 500-class error that points operators at the re-enter path.
    throw new RekeyError({
      statusCode: 500,
      code: 'BILLING_CREDENTIALS_DECRYPT_FAILED',
      message: `Stored credentials for "${expected}" cannot be decrypted: ${(e as Error).message}`,
      fix: 'Re-enter credentials via PUT /tenant/applications/:id/billing-credentials/:provider.',
    });
  }
  if (decrypted === null || typeof decrypted !== 'object') {
    throw new RekeyError({
      statusCode: 500,
      code: 'BILLING_CREDENTIALS_SHAPE_INVALID',
      message: `Stored credentials for "${expected}" decrypted to a non-object. Corruption suspected.`,
      fix: 'Re-enter credentials via PUT /tenant/applications/:id/billing-credentials/:provider.',
    });
  }
  // Legacy wrapped shape: { provider, data }, unwrap.
  if ('provider' in decrypted && 'data' in decrypted) {
    const w = decrypted as { provider: string; data: unknown };
    if (w.provider !== expected) {
      throw new RekeyError({
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
      let webhookConfigured: boolean;
      try {
        webhookConfigured = hasWebhookConfigured(
          r.provider as BillingProviderName,
          unwrap(r.ciphertext, r.provider as BillingProviderName),
        );
      } catch {
        // Undecryptable row (rotated key / corruption), surface as not
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
        currencies: r.currencies,
        unsupportedCurrencies: unsupportedCurrenciesOf(r.provider, r.currencies),
        webhookConfigured,
      };
    });
  },

  /**
   * Is this provider configured at all for the Application? A bare existence
   * check, no decryption, no enabled/mode filtering, for callers that only
   * need to know whether reaching for a provider instance would throw.
   */
  async isConfigured(applicationId: string, provider: BillingProviderName): Promise<boolean> {
    const row = await prisma.billingCredentials.findUnique({
      where: { applicationId_provider: { applicationId, provider } },
      select: { applicationId: true },
    });
    return row !== null;
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
   * Always returns *every* enabled provider, the country argument only
   * affects ordering, not filtering. The /providers listing surface and the
   * pickProvider geo-router both read from here:
   *
   *   - /providers UI: shows the full picker; country-matching ones float to
   *     the top so the IN user sees Razorpay first but PayPal still appears.
   *   - pickProvider: takes the first entry of this order.
   *
   * Sort order:
   *   1. Country-specific match (countries[] contains country), by priority.
   *   2. Global / fallback (countries[] empty), by priority.
   *   3. Other country-restricted that don't match, by priority.
   */
  async listEnabled(
    applicationId: string,
    country?: string,
  ): Promise<EnabledProvider[]> {
    const rows = await prisma.billingCredentials.findMany({
      where: { applicationId, enabled: true },
      orderBy: { priority: 'asc' },
      select: { provider: true, priority: true, countries: true, currencies: true, mode: true },
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
        currencies: r.currencies,
        unsupportedCurrencies: unsupportedCurrenciesOf(r.provider, r.currencies),
        mode: (r.mode === 'live' ? 'live' : 'test') as BillingMode,
        _s: score(r),
      }))
      // Equal priorities fall to the module's own default order and then the
      // name, so routing never depends on the order rows were saved in.
      .sort(
        (a, b) =>
          a._s - b._s ||
          a.priority - b.priority ||
          defaultPriority(a.provider) - defaultPriority(b.provider) ||
          a.provider.localeCompare(b.provider),
      )
      .map(({ _s: _, ...rest }) => rest);
  },

  /**
   * `listEnabled` restricted to providers a buyer can be sent to.
   *
   * An inbound-only module (`capabilities.checkout: false`) is configured and
   * enabled like any other, and must be for its webhooks to verify, but it
   * cannot host a checkout. The geo router and the public provider list read
   * this; the credential surfaces and the bound-provider checks read
   * `listEnabled`, because "is this provider configured" is a different
   * question from "can a buyer pay here".
   */
  async listCheckoutEnabled(applicationId: string, country?: string): Promise<EnabledProvider[]> {
    const rows = await this.listEnabled(applicationId, country);
    return rows.filter((r) => getModule(r.provider)?.capabilities.checkout !== false);
  },

  /**
   * The ONE generic upsert (P3): validates `data` against the module's
   * `credentialSchema` rules (pattern prefixes, required fields, same
   * messages and precedence the hand-written per-provider validators had,
   * derived via `credentialRulesSchema`), runs the module's optional
   * `validateCredentials` escape hatch, then stores. Blank optional webhook
   * fields are allowed, "Auto-configure webhook" (registerWebhook) fills
   * them in later via the provider API.
   */
  async upsertCredentials(
    applicationId: string,
    provider: BillingProviderName,
    data: Record<string, string>,
    options?: CredentialOptions,
  ): Promise<void> {
    const module = requireModule(provider);
    const { merged, hadStored } = await this.mergeOverStored(applicationId, provider, data);
    const parsed = credentialRulesSchema(module).safeParse(merged);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const fix = (issue as { params?: { fix?: string } }).params?.fix;
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_CREDENTIALS_INVALID',
        message: issue.message,
        ...(fix !== undefined && { fix }),
      });
    }
    module.validateCredentials?.(merged);
    // Preserve the stored mode on a partial edit. `resolveMode` falls back to
    // 'test' for any provider without `detectMode` (PayPal has none), so an
    // edit that omits `mode` used to relabel a live account as sandbox and
    // point every call at the sandbox host. Only an explicit `mode`, or one the
    // key material states, may change it.
    const opts = { ...options };
    if (hadStored && opts.mode === undefined) {
      const existing = await prisma.billingCredentials.findUnique({
        where: { applicationId_provider: { applicationId, provider } },
        select: { mode: true },
      });
      if (existing) opts.mode = existing.mode === 'live' ? 'live' : 'test';
    }
    await this.upsertRaw(applicationId, provider, merged, opts);
  },

  /**
   * Merge an edit over the stored credentials.
   *
   * A field that is ABSENT from the request keeps whatever is stored. A field
   * that is PRESENT and empty is cleared, which is what a blank optional field
   * has always meant (blanking Stripe's `webhookSecret` is how you drop a
   * signing secret). Keeping those two cases distinct is the whole rule.
   *
   * The reason this exists: stored credentials are encrypted and never returned
   * to the panel, so an edit form renders every input empty. Sending that form
   * back overwrote each field with an empty string, so changing one URL meant
   * re-fetching the API key from the provider dashboard.
   *
   * An earlier version of this keyed off `field.secret`, which was wrong twice
   * over. It wiped non-secret fields that were merely omitted, including
   * PayPal's `webhookId` (every inbound webhook then 503s), and it rested on
   * the claim that non-secret fields "render with their current value". No
   * endpoint returns credential values, so they render empty exactly like
   * secrets do.
   *
   * Limits that keep this from being a hole:
   *   - Only when a credential row already exists. First configuration has
   *     nothing to merge, so a missing required field still fails.
   *   - The merged result still goes through the full rules check, so a
   *     carried-forward value that no longer satisfies the provider's pattern
   *     is refused exactly like a freshly typed one.
   *   - Nothing is returned to the caller: a value travels from the row,
   *     through the merge, back into the ciphertext, and is never exposed.
   */
  async mergeOverStored(
    applicationId: string,
    provider: BillingProviderName,
    data: Record<string, string | undefined>,
  ): Promise<{ merged: Record<string, string>; hadStored: boolean }> {
    const module = requireModule(provider);
    const keys = module.credentialSchema.map((f) => f.key);
    const absent = keys.filter((k) => data[k] === undefined);

    const normalise = (source: Record<string, string | undefined>): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const k of keys) out[k] = source[k] ?? '';
      return out;
    };

    if (absent.length === 0) return { merged: normalise(data), hadStored: false };

    const row = await prisma.billingCredentials.findUnique({
      where: { applicationId_provider: { applicationId, provider } },
      select: { ciphertext: true },
    });
    if (!row) return { merged: normalise(data), hadStored: false };

    let stored: Record<string, unknown>;
    try {
      // `unwrap`, not a bare decrypt: rows backfilled from the old
      // per-application ciphertext are wrapped, and a bare decrypt would carry
      // nothing forward and then blame the operator for a key that is stored
      // and working.
      stored = unwrap(row.ciphertext, provider) as unknown as Record<string, unknown>;
    } catch {
      // Undecryptable stored credentials are a re-enter-everything situation.
      // Carry nothing and let the normal required-field validation say so.
      return { merged: normalise(data), hadStored: false };
    }
    if (stored === null || typeof stored !== 'object') {
      return { merged: normalise(data), hadStored: false };
    }

    const merged: Record<string, string | undefined> = { ...data };
    for (const k of absent) {
      const prior = stored[k];
      if (typeof prior === 'string') merged[k] = prior;
    }
    return { merged: normalise(merged), hadStored: true };
  },

  async upsertRaw(
    applicationId: string,
    provider: BillingProviderName,
    data: unknown,
    options?: CredentialOptions,
  ): Promise<void> {
    const ciphertext = encryptJson(data);
    const countries = (options?.countries ?? []).map((c) => c.toUpperCase().trim()).filter(Boolean);
    const mode = resolveMode(provider, data, options?.mode);
    const previous = await this.loadDecrypted(applicationId, provider).catch(() => null);
    const previousMode = (
      await prisma.billingCredentials.findUnique({
        where: { applicationId_provider: { applicationId, provider } },
        select: { mode: true },
      })
    )?.mode;
    // A relabelled mode restarts the window too: a PayPal sandbox and live
    // client id look alike, so rows recorded under the old label prove nothing
    // about the new one.
    const secretsChanged =
      previous === null || canonicalJson(previous) !== canonicalJson(data) || previousMode !== mode;
    const createCurrencies = normaliseCurrencies(provider, options?.currencies ?? currenciesForNewRow(provider));
    const updateCurrencies =
      options?.currencies === undefined ? undefined : normaliseCurrencies(provider, options.currencies);
    await prisma.$transaction(async (tx) => {
      const stored = await tx.billingCredentials.findUnique({
        where: { applicationId_provider: { applicationId, provider } },
        select: { currencies: true },
      });
      const saved = await tx.billingCredentials.upsert({
        where: { applicationId_provider: { applicationId, provider } },
        create: {
          applicationId,
          provider,
          ciphertext,
          countries,
          currencies: createCurrencies,
          priority: options?.priority ?? 100,
          enabled: options?.enabled ?? true,
          mode,
        },
        update: {
          ciphertext,
          mode,
          ...(secretsChanged && { secretsUpdatedAt: new Date() }),
          ...(options?.countries !== undefined && { countries }),
          ...(updateCurrencies !== undefined && { currencies: updateCurrencies }),
          ...(options?.priority !== undefined && { priority: options.priority }),
          ...(options?.enabled !== undefined && { enabled: options.enabled }),
        },
        select: { currencies: true },
      });
      await recordCurrenciesChange(tx, {
        applicationId,
        provider,
        before: stored?.currencies ?? [],
        after: saved.currencies,
        operatorId: options?.operatorId,
      });
    });
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

  /**
   * Relabel a stored credential's mode. Same rule as the upsert: if the stored
   * key material states its mode, this cannot contradict it, otherwise
   * `setMode` would be a second door to the exact hole `resolveMode` closes.
   */
  async setMode(
    applicationId: string,
    provider: BillingProviderName,
    mode: BillingMode,
  ): Promise<void> {
    const current = await this.loadDecrypted(applicationId, provider);
    if (current === null) {
      throw new RekeyError({
        statusCode: 404,
        code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
        message: `No ${provider} credentials are stored for this Application.`,
        fix: `Save the ${provider} credentials first; the mode is read from them.`,
      });
    }
    const resolved = resolveMode(provider, current, mode);
    const row = await prisma.billingCredentials.findUnique({
      where: { applicationId_provider: { applicationId, provider } },
      select: { mode: true },
    });
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId, provider } },
      data: { mode: resolved, ...(row?.mode !== resolved && { secretsUpdatedAt: new Date() }) },
    });
  },

  /**
   * Refuse before touching a row that is not there.
   *
   * `setMode` has always done this; `setRouting` and `remove` went straight to
   * a Prisma `update`/`delete`, which throws `P2025` on a missing row and
   * reaches the error handler as a 500. An external audit hit it on all three
   * providers. A caller asking to change or remove credentials that were never
   * stored has made an ordinary mistake, not caused a server fault, and the
   * in-module convention for it already existed one method up.
   */
  async assertConfigured(applicationId: string, provider: BillingProviderName): Promise<void> {
    const row = await prisma.billingCredentials.findUnique({
      where: { applicationId_provider: { applicationId, provider } },
      select: { id: true },
    });
    if (row) return;
    throw new RekeyError({
      statusCode: 404,
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
      message: `No ${provider} credentials are stored for this Application.`,
      fix: `Save the ${provider} credentials first.`,
    });
  },

  async setRouting(
    applicationId: string,
    provider: BillingProviderName,
    countries: string[],
    priority: number,
  ): Promise<void> {
    await this.assertConfigured(applicationId, provider);
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId, provider } },
      data: {
        countries: countries.map((c) => c.toUpperCase().trim()).filter(Boolean),
        priority,
      },
    });
  },

  /**
   * Declare which currencies this provider account can charge. An empty list
   * is kept as it is and means none: the provider is not used for any checkout.
   *
   * The change is written to the billing log as `provider.currencies_changed`,
   * naming `operatorId` when there is one.
   *
   * @example
   * await billingCredentialsService.setCurrencies(appId, 'razorpay', ['INR'], operatorId);
   */
  async setCurrencies(
    applicationId: string,
    provider: BillingProviderName,
    currencies: string[],
    operatorId?: string,
  ): Promise<void> {
    await this.assertConfigured(applicationId, provider);
    const after = normaliseCurrencies(provider, currencies);
    await prisma.$transaction(async (tx) => {
      const stored = await tx.billingCredentials.findUniqueOrThrow({
        where: { applicationId_provider: { applicationId, provider } },
        select: { currencies: true },
      });
      await tx.billingCredentials.update({
        where: { applicationId_provider: { applicationId, provider } },
        data: { currencies: after },
      });
      await recordCurrenciesChange(tx, { applicationId, provider, before: stored.currencies, after, operatorId });
    });
  },

  async remove(applicationId: string, provider: BillingProviderName): Promise<void> {
    await this.assertConfigured(applicationId, provider);
    await prisma.billingCredentials.delete({
      where: { applicationId_provider: { applicationId, provider } },
    });
  },
};

/** JSON with object keys sorted, so two equal credential objects compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
