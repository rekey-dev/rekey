/**
 * Which sandbox credentials this run has, and what to do when it has none.
 *
 * The whole harness is gated here. Every suite declares the credential it
 * needs; a suite whose credential is absent is SKIPPED WITH ITS REASON IN THE
 * TITLE, so `vitest` prints
 *
 *     ↓ Stripe sandbox · checkout — SKIPPED: set STRIPE_TEST_SECRET_KEY … (4 tests)
 *
 * rather than silently reporting a smaller passing count. A contributor
 * without keys learns why in the run output, not by reading this file.
 *
 * ## A skipped suite must never read as a green one
 *
 * Skipping is right for a contributor and wrong for the CI job that exists
 * *because* the secrets are configured: a rotated secret would turn that job
 * green while testing nothing. `REKEY_SANDBOX_REQUIRE` is the answer — set it
 * to `all`, or to a comma-separated list of provider names, and a missing
 * credential FAILS the run instead of skipping it. The opt-in CI job sets it.
 *
 * The env var NAMES live in `support/env-vars.ts`, which imports nothing from
 * vitest — `global-setup.ts` needs them for its banner and runs in a context
 * where importing `describe` fails the whole run.
 */

import { describe } from 'vitest';
import { appendFileSync } from 'node:fs';
import { registerSecret } from './redact.js';
import {
  BROWSER_VAR,
  PAYPAL_CLIENT_ID_VAR,
  PAYPAL_CLIENT_SECRET_VAR,
  PAYPAL_WEBHOOK_ID_VAR,
  RAZORPAY_KEY_ID_VAR,
  RAZORPAY_KEY_SECRET_VAR,
  REQUIRE_VAR,
  SKIP_LOG_VAR,
  STRIPE_KEY_VAR,
} from './env-vars.js';

export {
  BROWSER_VAR,
  PAYPAL_CLIENT_ID_VAR,
  PAYPAL_CLIENT_SECRET_VAR,
  PAYPAL_WEBHOOK_ID_VAR,
  RAZORPAY_KEY_ID_VAR,
  RAZORPAY_KEY_SECRET_VAR,
  STRIPE_KEY_VAR,
} from './env-vars.js';

export type ProviderId = 'stripe' | 'paypal' | 'razorpay';

function env(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

export interface StripeSandbox {
  /** The `sk_test_…` secret key. Never logged — see `support/redact.ts`. */
  apiKey: string;
}

export interface PaypalSandbox {
  clientId: string;
  clientSecret: string;
  /** Optional: a pre-created sandbox webhook id for online verification. */
  webhookId: string | undefined;
}

export interface RazorpaySandbox {
  keyId: string;
  keySecret: string;
}

/**
 * Read the Stripe sandbox key, refusing a LIVE one outright.
 *
 * A live key here would create real products, real prices and real charges in
 * somebody's account, and the cleanup at the end of the run would delete real
 * objects. `sk_live_` is not "credentials the operator chose to supply"; it is
 * an accident, and the harness is the last place that can still catch it.
 */
export function stripeSandbox(): StripeSandbox | { error: string } {
  const apiKey = env(STRIPE_KEY_VAR);
  if (!apiKey) {
    return {
      error:
        `set ${STRIPE_KEY_VAR} to a Stripe TEST-mode secret key (sk_test_…) — ` +
        'see docs/provider-sandbox-testing.md',
    };
  }
  if (apiKey.startsWith('sk_live_')) {
    return {
      error:
        `${STRIPE_KEY_VAR} holds a LIVE key. This harness creates and DELETES objects in the ` +
        'account it is pointed at — it refuses to run against live mode. Use sk_test_….',
    };
  }
  if (!apiKey.startsWith('sk_test_')) {
    return {
      error:
        `${STRIPE_KEY_VAR} does not look like a Stripe test secret key (expected an sk_test_ prefix). ` +
        'A restricted key (rk_test_…) lacks the product/price/webhook permissions this harness needs.',
    };
  }
  registerSecret(apiKey, STRIPE_KEY_VAR);
  return { apiKey };
}

export function paypalSandbox(): PaypalSandbox | { error: string } {
  const clientId = env(PAYPAL_CLIENT_ID_VAR);
  const clientSecret = env(PAYPAL_CLIENT_SECRET_VAR);
  if (!clientId || !clientSecret) {
    return {
      error:
        `set ${PAYPAL_CLIENT_ID_VAR} and ${PAYPAL_CLIENT_SECRET_VAR} from a PayPal Developer ` +
        'SANDBOX REST app — see docs/provider-sandbox-testing.md',
    };
  }
  registerSecret(clientSecret, PAYPAL_CLIENT_SECRET_VAR);
  registerSecret(clientId, PAYPAL_CLIENT_ID_VAR);
  return { clientId, clientSecret, webhookId: env(PAYPAL_WEBHOOK_ID_VAR) };
}

export function razorpaySandbox(): RazorpaySandbox | { error: string } {
  const keyId = env(RAZORPAY_KEY_ID_VAR);
  const keySecret = env(RAZORPAY_KEY_SECRET_VAR);
  if (!keyId || !keySecret) {
    return {
      error:
        `set ${RAZORPAY_KEY_ID_VAR} and ${RAZORPAY_KEY_SECRET_VAR} from a Razorpay TEST-mode ` +
        'key pair — see docs/provider-sandbox-testing.md',
    };
  }
  if (keyId.startsWith('rzp_live_')) {
    return {
      error: `${RAZORPAY_KEY_ID_VAR} holds a LIVE key id. This harness refuses to run against live mode.`,
    };
  }
  registerSecret(keySecret, RAZORPAY_KEY_SECRET_VAR);
  return { keyId, keySecret };
}

/** True when the operator asked for `provider` to be a hard requirement. */
function isRequired(provider: ProviderId): boolean {
  const raw = env(REQUIRE_VAR);
  if (!raw) return false;
  const wanted = raw.toLowerCase().split(',').map((s) => s.trim());
  return wanted.includes('all') || wanted.includes('1') || wanted.includes(provider);
}

/**
 * Record a skip where the harness's global teardown can find it.
 *
 * A file, not a module variable: vitest runs suites in a forked child, and the
 * banner is printed by `global-setup.ts` in the parent. The path is handed
 * down through the environment (see `global-setup.ts`); when it is absent —
 * someone running a single file with `vitest --config` by hand — the skip is
 * still in the suite title, so nothing is lost.
 */
function recordSkip(provider: ProviderId, title: string, reason: string): void {
  const path = process.env[SKIP_LOG_VAR];
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ provider, title, reason })}\n`);
  } catch {
    /* best-effort — a banner is not worth failing a run over */
  }
}

/**
 * Declare a suite that needs a live sandbox credential.
 *
 * `resolve` returns either the credential bundle or `{ error }` naming the env
 * var to set. On `{ error }` the suite is skipped with the reason in its title
 * — unless `REKEY_SANDBOX_REQUIRE` names this provider, in which case the
 * suite runs and fails immediately, because a CI job that was configured with
 * secrets and quietly stopped exercising them is the failure mode this whole
 * harness exists to prevent.
 */
export function describeSandbox<T extends object>(
  provider: ProviderId,
  title: string,
  resolve: () => T | { error: string },
  suite: (credentials: T) => void,
): void {
  const resolved = resolve();
  if (!('error' in resolved)) {
    describe(title, () => suite(resolved as T));
    return;
  }
  const reason = (resolved as { error: string }).error;
  if (isRequired(provider)) {
    describe(title, () => {
      throw new Error(
        `REKEY_SANDBOX_REQUIRE names "${provider}", but its credentials are missing: ${reason}`,
      );
    });
    return;
  }
  recordSkip(provider, title, reason);
  // The body of a `describe.skip` is still EXECUTED — that is how vitest
  // enumerates the tests it is about to report as skipped. So a suite that
  // touched `credentials.apiKey` at describe level would throw during
  // collection and turn a clean skip into a red run. Hand it a stand-in that
  // answers every property with a harmless placeholder; the `it` bodies that
  // would use it never run.
  describe.skip(`${title} — SKIPPED: ${reason}`, () => suite(unsetCredentials<T>()));
}

/** Placeholder credential bundle for a skipped suite — see `describeSandbox`. */
function unsetCredentials<T extends object>(): T {
  return new Proxy({} as T, {
    get: (_target, prop) => (typeof prop === 'string' ? `unset-${prop}` : undefined),
  });
}

/**
 * Whether the browser-driven Checkout completion may run.
 *
 * Kept separate from credentials: it is a *tooling* prerequisite (a Playwright
 * browser binary), not a secret, and the reason string has to name the install
 * command rather than an env var.
 */
export function browserCompletionEnabled(): { ok: true } | { error: string } {
  if (!env(BROWSER_VAR)) {
    return {
      error:
        `set ${BROWSER_VAR}=1 to complete Checkout Sessions in a real browser ` +
        '(needs `pnpm exec playwright install chromium`) — see docs/provider-sandbox-testing.md',
    };
  }
  return { ok: true };
}
