/**
 * The harness's own safety mechanism, tested.
 *
 * This suite needs no credentials and therefore always runs — deliberately.
 * Redaction is the one part of the harness whose failure is silent and
 * expensive: a leaked `sk_test_…` in a CI log is in a retention system, a PR
 * check page, and wherever that log was forwarded, and nothing about the run
 * looks wrong. A guard that is only exercised on machines that have keys is a
 * guard that is only exercised where it matters least.
 */

import { describe, expect, it } from 'vitest';
import { fakeCredential, redact, registerSecret } from './support/redact.js';

describe('harness · secret redaction', () => {
  it('replaces a registered credential and names the variable it came from', () => {
    const key = fakeCredential('sk_test_', 'STRIPE_TEST_SECRET_KEY');
    const line = `Invalid API Key provided: ${key}`;
    const out = redact(line);
    expect(out).not.toContain(key);
    expect(out).toContain('redacted');
  });

  it('redacts a key it has never been told about', () => {
    // The case `registerSecret` cannot cover: a secret minted mid-run by
    // `registerWebhook`, or read from somewhere the harness does not look.
    const out = redact('endpoint secret whsec_ZmFrZVNlY3JldFZhbHVlMTIzNDU2Nzg5');
    expect(out).not.toContain('whsec_ZmFrZVNlY3JldFZhbHVl');
    expect(out).toContain('[redacted:webhook-signing-secret]');
  });

  it("redacts a provider's own MASKED echo of a key", () => {
    // Stripe answers a bad key with `Invalid API Key provided:
    // sk_test_****…abac`. The visible suffix is enough to correlate a key
    // against a list, so the mask is not our redaction to rely on.
    const out = redact('Invalid API Key provided: sk_test_************************abac');
    expect(out).not.toContain('abac');
    expect(out).toContain('[redacted:stripe-secret-key]');
  });

  it('redacts the longest registered secret first', () => {
    // A credential that CONTAINS another registered credential must be
    // replaced whole, or the leftover tail is still a key fragment.
    const short = 'aaaaaaaaaaaaaaaa';
    const long = `${short}bbbbbbbbbbbbbbbb`;
    registerSecret(short, 'SHORT');
    registerSecret(long, 'LONG');
    expect(redact(long)).toBe('[redacted:LONG]');
  });

  it('leaves ordinary output alone', () => {
    const line = 'checkout completed processed { sessionId: cs_test_a1b2, matched: 1 }';
    expect(redact(line)).toBe(line);
  });

  it('ignores values too short to be a credential', () => {
    // Registering a short string would turn ordinary output into confetti and
    // make failures unreadable — which is its own way of hiding a bug.
    registerSecret('short', 'TOO_SHORT');
    expect(redact('a short word here')).toBe('a short word here');
  });
});
