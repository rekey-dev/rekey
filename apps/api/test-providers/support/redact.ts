/**
 * Secret scrubbing for the sandbox harness.
 *
 * This suite is the only place in the repo that holds a REAL payment-provider
 * credential in `process.env`, and it is also the place most likely to print
 * one: vitest renders the full `expected`/`actual` of a failing assertion, and
 * provider SDKs put request context (sometimes including a key fragment) into
 * the exceptions they throw. A green run that leaks `sk_test_…` into a CI log
 * is worse than no run at all — the key is then in a log retention system, a
 * PR check page, and anywhere the log was forwarded.
 *
 * Two layers, because either alone has a hole:
 *
 *   1. `registerSecret` — exact-value replacement for every credential the
 *      harness read out of the environment. Catches anything that quotes a key
 *      verbatim.
 *   2. Prefix patterns — `sk_test_…`, `whsec_…`, `rzp_test_…` and friends,
 *      matched structurally. Catches keys the harness never saw: a secret
 *      echoed back by a provider in a masked form (`sk_test_51A****9Z`), one
 *      that arrived from a config file rather than `registerSecret`, or a
 *      SECOND key minted mid-run by `registerWebhook`.
 *
 * The patterns deliberately allow `*` inside the token so a provider's own
 * masked echo is still redacted: the visible suffix of a masked key is enough
 * to correlate it against a key list, and the mask is not our redaction to
 * rely on.
 *
 * Installed onto `process.stdout` / `process.stderr` rather than `console`,
 * because vitest's reporter writes assertion diffs straight to the stream.
 */

import { randomUUID } from 'node:crypto';

/** Exact credential values the harness has been handed, longest first. */
const exactSecrets = new Map<string, string>();

/**
 * Structural patterns for provider credentials, applied to every line of
 * output whether or not the value was ever registered.
 *
 * `[A-Za-z0-9_*]` includes `*` on purpose — see the module header.
 */
const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk_(?:test|live)_[A-Za-z0-9_*]{6,}/g, label: 'stripe-secret-key' },
  { re: /rk_(?:test|live)_[A-Za-z0-9_*]{6,}/g, label: 'stripe-restricted-key' },
  { re: /whsec_[A-Za-z0-9_*+/=]{6,}/g, label: 'webhook-signing-secret' },
  { re: /rzp_(?:test|live)_[A-Za-z0-9_*]{6,}/g, label: 'razorpay-key-id' },
  // PayPal client secrets are unprefixed random strings, so they are only
  // reachable through `registerSecret`. The access token is not.
  { re: /\bA21AA[A-Za-z0-9_-]{20,}/g, label: 'paypal-access-token' },
];

/**
 * Register a credential value for exact redaction.
 *
 * `label` names the ENV VAR it came from, so a redacted line still tells the
 * reader which credential was involved — `[redacted:STRIPE_TEST_SECRET_KEY]`
 * is diagnostic; `[redacted]` is not.
 */
export function registerSecret(value: string | undefined | null, label: string): void {
  // Short values would turn ordinary output into confetti. Nothing shorter
  // than this is a usable provider credential.
  if (typeof value !== 'string' || value.length < 12) return;
  exactSecrets.set(value, `[redacted:${label}]`);
}

/** Replace every known secret and every structurally-recognised one. */
export function redact(text: string): string {
  let out = text;
  // Longest first: a secret that contains another registered secret as a
  // substring must be replaced whole.
  for (const value of [...exactSecrets.keys()].sort((a, b) => b.length - a.length)) {
    if (out.includes(value)) out = out.split(value).join(exactSecrets.get(value)!);
  }
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, `[redacted:${label}]`);
  }
  return out;
}

let installed = false;

/**
 * Wrap `process.stdout.write` / `process.stderr.write` so nothing reaches a
 * terminal or a CI log without passing through `redact`.
 *
 * Idempotent — setup files can run more than once per worker.
 */
export function installOutputScrubber(): void {
  if (installed) return;
  installed = true;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    // The overloads of `Writable.write` differ only in argument order, and the
    // harness never needs to distinguish them — pass everything through.
    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') {
        return (original as (c: string, ...r: unknown[]) => boolean)(redact(chunk), ...rest);
      }
      if (Buffer.isBuffer(chunk)) {
        return (original as (c: string, ...r: unknown[]) => boolean)(
          redact(chunk.toString('utf8')),
          ...rest,
        );
      }
      return (original as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
  }
}

/**
 * A credential-shaped value that is syntactically valid and definitely not a
 * real key — for the "provider refuses this" tests, and for the local webhook
 * signing secret.
 *
 * Generated per call rather than hard-coded so it can never be mistaken for
 * (or accidentally become) a real credential, and registered for redaction so
 * it does not clutter a diff either.
 */
export function fakeCredential(prefix: string, label: string): string {
  const value = `${prefix}${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
  registerSecret(value, label);
  return value;
}
