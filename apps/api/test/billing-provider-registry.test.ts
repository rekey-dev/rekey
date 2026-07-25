/**
 * Provider-module registry integrity (spec: billing-provider-modules).
 *
 * Guards the registry invariants CI is supposed to catch at review time:
 * every directory under providers/modules/ is registered, every module's
 * `name` equals its directory name, and the credential schema keys match
 * the JSON keys of today's stored encrypted blobs (zero-migration rule).
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  credentialDataSchema,
  credentialRulesSchema,
  getModule,
  providerDescriptor,
  providerNameSchema,
  registryNames,
} from '../src/modules/billing/providers/registry.js';
import { stripeModule } from '../src/modules/billing/providers/modules/stripe/index.js';
import { razorpayModule } from '../src/modules/billing/providers/modules/razorpay/index.js';
import { paypalModule } from '../src/modules/billing/providers/modules/paypal/index.js';

const modulesDir = fileURLToPath(
  new URL('../src/modules/billing/providers/modules/', import.meta.url),
);

describe('billing provider-module registry', () => {
  it('registers exactly the modules present on disk (name ⇔ directory)', () => {
    const dirs = readdirSync(modulesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect([...registryNames].sort()).toEqual(dirs);
    for (const name of registryNames) {
      expect(getModule(name)?.name).toBe(name);
    }
  });

  it('registers all three built-in providers (P2)', () => {
    expect([...registryNames].sort()).toEqual(['paypal', 'razorpay', 'stripe']);
  });

  it('exposes a zod enum derived from the registry', () => {
    expect(providerNameSchema.safeParse('stripe').success).toBe(true);
    expect(providerNameSchema.safeParse('razorpay').success).toBe(true);
    expect(providerNameSchema.safeParse('paypal').success).toBe(true);
    expect(providerNameSchema.safeParse('visa').success).toBe(false);
  });

  it('every module declares at most one webhookRole field', () => {
    // The pipeline's 503 gate checks a single field by design — a module
    // declaring two would silently leave the second unchecked.
    for (const name of registryNames) {
      const fields = getModule(name)!.credentialSchema.filter((f) => f.webhookRole);
      expect(fields.length, `${name} declares ${fields.length} webhookRole fields`).toBeLessThanOrEqual(1);
    }
  });

  it('stripe credentialSchema matches the stored credential JSON keys exactly', () => {
    // StripeCredentials in credentials.service.ts is { apiKey, webhookSecret }.
    // A key rename here would strand every existing encrypted blob.
    expect(stripeModule.credentialSchema.map((f) => f.key)).toEqual(['apiKey', 'webhookSecret']);
    const webhookField = stripeModule.credentialSchema.find((f) => f.webhookRole);
    expect(webhookField?.key).toBe('webhookSecret');
    expect(webhookField?.webhookRole).toBe('secret');
    // Prefix rules mirror upsertStripe's validation.
    expect(stripeModule.credentialSchema.find((f) => f.key === 'apiKey')?.pattern?.prefix).toBe(
      'sk_',
    );
    expect(webhookField?.pattern?.prefix).toBe('whsec_');
  });

  it('razorpay credentialSchema matches the stored credential JSON keys exactly', () => {
    // RazorpayCredentials in credentials.service.ts is
    // { keyId, keySecret, webhookSecret }. A key rename here would strand
    // every existing encrypted blob.
    expect(razorpayModule.credentialSchema.map((f) => f.key)).toEqual([
      'keyId',
      'keySecret',
      'webhookSecret',
    ]);
    const webhookField = razorpayModule.credentialSchema.find((f) => f.webhookRole);
    expect(webhookField?.key).toBe('webhookSecret');
    expect(webhookField?.webhookRole).toBe('secret');
    // Prefix rule mirrors upsertRazorpay's validation.
    expect(razorpayModule.credentialSchema.find((f) => f.key === 'keyId')?.pattern?.prefix).toBe(
      'rzp_',
    );
  });

  it('paypal credentialSchema matches the stored credential JSON keys exactly', () => {
    // PaypalCredentials in credentials.service.ts is
    // { clientId, clientSecret, webhookId }.
    expect(paypalModule.credentialSchema.map((f) => f.key)).toEqual([
      'clientId',
      'clientSecret',
      'webhookId',
    ]);
    const webhookField = paypalModule.credentialSchema.find((f) => f.webhookRole);
    expect(webhookField?.key).toBe('webhookId');
    expect(webhookField?.webhookRole).toBe('id');
  });

  it('stripe + razorpay declare offline verification (never test-skipped by the pipeline)', () => {
    expect(stripeModule.capabilities.onlineVerify).toBe(false);
    expect(razorpayModule.capabilities.onlineVerify).toBe(false);
  });

  it('paypal declares online verification + capture step + no native period rotation', () => {
    // These three drive real pipeline/applier behavior: the centralized
    // test-skip gate, the checkout.approved capture path, and the
    // period_advanced renewal rotation.
    expect(paypalModule.capabilities.onlineVerify).toBe(true);
    expect(paypalModule.capabilities.captureStep).toBe(true);
    expect(paypalModule.capabilities.periodRotationEvents).toBe(false);
  });

  it('razorpay declares manual webhook registration (panel sends operators to the dashboard)', () => {
    expect(razorpayModule.capabilities.autoWebhookRegister).toBe(false);
  });
});

describe('credentialSchema-driven validation (P3)', () => {
  // Known-good fixture creds per provider — the same shapes the webhook and
  // phase4 test suites store via the credential routes.
  const goodCreds: Record<string, Record<string, string>> = {
    stripe: { apiKey: 'sk_test_abc123', webhookSecret: 'whsec_abc123' },
    razorpay: { keyId: 'rzp_test_abc123', keySecret: 'secret_abc', webhookSecret: 'wh_secret' },
    paypal: { clientId: 'client_abc123', clientSecret: 'secret_abc123', webhookId: 'wh_id_123' },
  };

  it('credentialRulesSchema accepts each provider\'s known-good creds', () => {
    for (const name of registryNames) {
      const res = credentialRulesSchema(getModule(name)!).safeParse(goodCreds[name]);
      expect(res.success, `${name} should accept its known-good creds`).toBe(true);
    }
  });

  it('credentialDataSchema (route body shape) accepts each provider\'s known-good creds', () => {
    for (const name of registryNames) {
      const res = credentialDataSchema(getModule(name)!).safeParse(goodCreds[name]);
      expect(res.success, `${name} body shape should accept its known-good creds`).toBe(true);
    }
  });

  it('rejects wrong-prefix creds with the module\'s own pattern message', () => {
    const stripeBad = credentialRulesSchema(stripeModule).safeParse({
      ...goodCreds.stripe,
      apiKey: 'pk_test_not_a_secret_key',
    });
    expect(stripeBad.success).toBe(false);
    if (!stripeBad.success) {
      expect(stripeBad.error.issues[0]!.message).toBe(
        'Stripe `apiKey` must start with `sk_` (live or test).',
      );
    }

    const stripeBadWebhook = credentialRulesSchema(stripeModule).safeParse({
      ...goodCreds.stripe,
      webhookSecret: 'not-a-signing-secret',
    });
    expect(stripeBadWebhook.success).toBe(false);
    if (!stripeBadWebhook.success) {
      expect(stripeBadWebhook.error.issues[0]!.message).toBe(
        'Stripe `webhookSecret`, when provided, must start with `whsec_`.',
      );
    }

    const razorpayBad = credentialRulesSchema(razorpayModule).safeParse({
      ...goodCreds.razorpay,
      keyId: 'key_not_razorpay',
    });
    expect(razorpayBad.success).toBe(false);
    if (!razorpayBad.success) {
      expect(razorpayBad.error.issues[0]!.message).toBe(
        'Razorpay `keyId` must start with `rzp_` (live or test).',
      );
    }
  });

  it('blank optional webhook fields pass (the "auto-configure later" path)', () => {
    expect(
      credentialRulesSchema(stripeModule).safeParse({ ...goodCreds.stripe, webhookSecret: '' })
        .success,
    ).toBe(true);
    expect(
      credentialRulesSchema(paypalModule).safeParse({ ...goodCreds.paypal, webhookId: '' })
        .success,
    ).toBe(true);
  });

  it('blank required fields raise the legacy aggregate "credentials require" message', () => {
    const paypalMissing = credentialRulesSchema(paypalModule).safeParse({
      ...goodCreds.paypal,
      clientSecret: '',
    });
    expect(paypalMissing.success).toBe(false);
    if (!paypalMissing.success) {
      expect(paypalMissing.error.issues[0]!.message).toBe(
        'PayPal credentials require `clientId` and `clientSecret`.',
      );
    }

    const razorpayMissing = credentialRulesSchema(razorpayModule).safeParse({
      ...goodCreds.razorpay,
      webhookSecret: '',
    });
    expect(razorpayMissing.success).toBe(false);
    if (!razorpayMissing.success) {
      expect(razorpayMissing.error.issues[0]!.message).toBe(
        'Razorpay credentials require `keyId`, `keySecret`, and `webhookSecret`.',
      );
    }
  });

  it('inferMode hooks reproduce the legacy per-provider inference', () => {
    // Stripe: sk_live_ → live, anything else → test.
    expect(stripeModule.inferMode?.({ apiKey: 'sk_live_x', webhookSecret: '' })).toBe('live');
    expect(stripeModule.inferMode?.({ apiKey: 'sk_test_x', webhookSecret: '' })).toBe('test');
    // Razorpay: rzp_live_ → live, anything else → test.
    expect(razorpayModule.inferMode?.({ keyId: 'rzp_live_x' })).toBe('live');
    expect(razorpayModule.inferMode?.({ keyId: 'rzp_test_x' })).toBe('test');
    // PayPal has no shape distinction — no hook; the service defaults to 'test'.
    expect(paypalModule.inferMode).toBeUndefined();
  });
});

describe('discovery projection (P4)', () => {
  it('providerDescriptor exposes exactly the discovery contract fields', () => {
    for (const name of registryNames) {
      const d = providerDescriptor(getModule(name)!);
      expect(Object.keys(d).sort()).toEqual([
        'capabilities',
        'credentialFields',
        'defaultCountries',
        'docsUrl',
        'label',
        'name',
        'priority',
      ]);
      expect(d.name).toBe(name);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.docsUrl).toMatch(/^https:\/\//);
      expect(Object.keys(d.capabilities).sort()).toEqual([
        'autoWebhookRegister',
        'captureStep',
        'oneTime',
        'onlineVerify',
        'periodRotationEvents',
      ]);
    }
  });

  it('credentialFields carry form metadata only — no stored values, no internals', () => {
    // The projection whitelist: anything outside these keys (webhookRole,
    // pattern.prefix/regex, future module internals) must NOT reach clients.
    const allowed = ['key', 'label', 'secret', 'optional', 'placeholder', 'help', 'pattern'];
    for (const name of registryNames) {
      const d = providerDescriptor(getModule(name)!);
      expect(d.credentialFields.map((f) => f.key)).toEqual(
        getModule(name)!.credentialSchema.map((f) => f.key),
      );
      for (const f of d.credentialFields) {
        for (const k of Object.keys(f)) {
          expect(allowed, `${name}.${f.key} leaks field "${k}"`).toContain(k);
        }
        expect(typeof f.secret).toBe('boolean');
        expect(typeof f.optional).toBe('boolean');
        // pattern is reduced to its operator-readable message only.
        if (f.pattern !== undefined) {
          expect(Object.keys(f.pattern)).toEqual(['message']);
        }
      }
    }
  });

  it('secret flags mirror the module schema (secret → password input in the panel)', () => {
    const d = providerDescriptor(stripeModule);
    expect(d.credentialFields.find((f) => f.key === 'apiKey')?.secret).toBe(true);
    const paypal = providerDescriptor(paypalModule);
    expect(paypal.credentialFields.find((f) => f.key === 'clientId')?.secret).toBe(false);
    expect(paypal.credentialFields.find((f) => f.key === 'clientSecret')?.secret).toBe(true);
  });
});
