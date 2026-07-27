/**
 * Static provider-module registry (docs/specs/billing-provider-modules.md).
 *
 * Static imports on purpose — no dynamic npm plugin loading in v1. The
 * webhook path mutates money state and this process holds the
 * credential-encryption key; in-tree modules get review, typechecking
 * against the appliers, and fixture-replay CI (see "Why not npm plugins
 * yet" in the spec).
 *
 * All three built-in providers are registered (P2); their legacy webhook
 * URLs are permanent aliases into the shared pipeline. The hand-written
 * `z.enum(['stripe','paypal','razorpay'])` sites elsewhere are replaced by
 * `providerNameSchema` in P3/P4.
 */

import { z } from 'zod';
import type { CredentialField, ProviderModule } from './module-types.js';
import { stripeModule } from './modules/stripe/index.js';
import { razorpayModule } from './modules/razorpay/index.js';
import { paypalModule } from './modules/paypal/index.js';

const modules = new Map<string, ProviderModule>([
  [stripeModule.name, stripeModule],
  [razorpayModule.name, razorpayModule],
  [paypalModule.name, paypalModule],
]);

/** Registered provider names, in registration order. */
export const registryNames: string[] = [...modules.keys()];

export function getModule(name: string): ProviderModule | undefined {
  return modules.get(name);
}

/**
 * Zod enum of registered provider names. Adding a module extends every
 * derived surface (generic webhook route today; credential routes and
 * discovery in P3/P4) without another hand-written union.
 */
export const providerNameSchema = z.enum(registryNames as [string, ...string[]]);

/**
 * Route-layer body shape for one provider's credential `data` object,
 * derived from `credentialSchema` (P3). Reproduces the hand-written
 * per-provider zod bodies exactly: required fields are 4–512 chars,
 * optional ones (blank = "auto-configure the webhook later") default to ''.
 * Unknown keys are stripped, as the per-provider `z.object`s did.
 *
 * Deliberately does NOT enforce `pattern` rules — those belong to the
 * credentials service (`credentialRulesSchema`), which converts violations
 * into the 400 BILLING_CREDENTIALS_INVALID envelope the tests pin. A
 * pattern failure here would surface as a generic zod validation error
 * instead.
 */
export function credentialDataSchema(module: ProviderModule): z.ZodType<Record<string, string>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of module.credentialSchema) {
    shape[f.key] = f.optional
      ? z.string().max(512).optional().default('')
      : z.string().min(4).max(512);
  }
  return z.object(shape) as unknown as z.ZodType<Record<string, string>>;
}

/**
 * One credential field as exposed by the tenant discovery endpoint (P4).
 * A deliberate PROJECTION of `CredentialField`: form-rendering fields only.
 * `pattern` is reduced to its operator-readable `message` (the prefix/regex
 * mechanics stay server-side — the panel never re-validates), and
 * `webhookRole` stays internal (the panel drives webhook UX off
 * `capabilities.autoWebhookRegister`, not per-field roles). Stored values
 * are structurally impossible here — the module never holds any.
 */
export interface ProviderCredentialFieldInfo {
  key: string;
  label: string;
  secret: boolean;
  optional: boolean;
  placeholder?: string;
  help?: string;
  pattern?: { message: string };
}

/** The module-descriptor half of the tenant discovery payload (P4). */
export interface ProviderDescriptorInfo {
  name: string;
  label: string;
  docsUrl: string;
  defaultCountries: string[];
  priority: number;
  capabilities: ProviderModule['capabilities'];
  credentialFields: ProviderCredentialFieldInfo[];
}

/**
 * Project a module into the discovery-endpoint descriptor (P4). Shared by
 * the tenant route and the registry tests so the "never leak secrets or
 * internals" contract is pinned in one place.
 */
export function providerDescriptor(module: ProviderModule): ProviderDescriptorInfo {
  return {
    name: module.name,
    label: module.display.label,
    docsUrl: module.display.docsUrl,
    defaultCountries: module.display.defaultCountries,
    priority: module.display.priority,
    capabilities: module.capabilities,
    credentialFields: module.credentialSchema.map((f) => ({
      key: f.key,
      label: f.label,
      secret: f.secret,
      optional: f.optional ?? false,
      ...(f.placeholder !== undefined && { placeholder: f.placeholder }),
      ...(f.help !== undefined && { help: f.help }),
      ...(f.pattern !== undefined && { pattern: { message: f.pattern.message } }),
    })),
  };
}

/** Oxford-comma'd backticked key list: "`a`, `b`, and `c`" / "`a` and `b`". */
function keyList(fields: CredentialField[]): string {
  const keys = fields.map((f) => `\`${f.key}\``);
  if (keys.length <= 1) return keys.join('');
  if (keys.length === 2) return keys.join(' and ');
  return `${keys.slice(0, -1).join(', ')}, and ${keys[keys.length - 1]}`;
}

/**
 * Semantic credential rules derived from `credentialSchema` — the generic
 * replacement for the hand-written upsertStripe/Paypal/Razorpay validators
 * (P3). Field order and precedence mirror the legacy code exactly:
 *
 *   - `pattern` is checked first per field (required fields always; optional
 *    fields only when non-blank — a blank optional webhook field means
 *    "auto-configure later"), with the module's own message.
 *   - A blank required field without a failing pattern raises the aggregate
 *     "<Label> credentials require `a`, `b`, and `c`." message the legacy
 *     validators used.
 *
 * At most ONE issue is emitted (first failure wins) so the credentials
 * service can map it 1:1 onto a RekeyError. `params.fix` carries the
 * field's `help` text (or a docsUrl pointer) for the error envelope's `fix`.
 */
export function credentialRulesSchema(module: ProviderModule): z.ZodType<Record<string, string>> {
  const required = module.credentialSchema.filter((f) => !f.optional);
  return z.record(z.string()).superRefine((data, ctx) => {
    for (const f of module.credentialSchema) {
      const value = data[f.key] ?? '';
      if (f.pattern && (value !== '' || !f.optional)) {
        const prefixOk = f.pattern.prefix === undefined || value.startsWith(f.pattern.prefix);
        const regexOk = f.pattern.regex === undefined || new RegExp(f.pattern.regex).test(value);
        if (!prefixOk || !regexOk) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [f.key],
            message: f.pattern.message,
            params: { ...(f.help !== undefined && { fix: f.help }) },
          });
          return;
        }
      }
      if (!f.optional && value === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [f.key],
          message: `${module.display.label} credentials require ${keyList(required)}.`,
          params: {
            fix: `Get these from the ${module.display.label} dashboard — see ${module.display.docsUrl}.`,
          },
        });
        return;
      }
    }
  }) as unknown as z.ZodType<Record<string, string>>;
}
