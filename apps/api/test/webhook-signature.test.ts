/**
 * Outbound webhook signatures: a tampered body, a different secret and a
 * timestamp outside the replay window all fail verification.
 */

import { expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from '../src/lib/webhook-signing.js';

it('verifyWebhookSignature: tampered body fails verification', () => {
  const body = '{"event":"x"}';
  const secret = 'a'.repeat(64);
  const { signatureHeader } = signWebhook({ body, secret });
  expect(verifyWebhookSignature({ body, secret, header: signatureHeader })).toBe(true);
  expect(verifyWebhookSignature({ body: '{"event":"y"}', secret, header: signatureHeader })).toBe(false);
  expect(verifyWebhookSignature({ body, secret: 'b'.repeat(64), header: signatureHeader })).toBe(false);
  // Replay window, present a 10-minute-old timestamp; should reject.
  const { signatureHeader: old } = signWebhook({
    body,
    secret,
    timestamp: Math.floor(Date.now() / 1000) - 600,
  });
  expect(verifyWebhookSignature({ body, secret, header: old })).toBe(false);
});
