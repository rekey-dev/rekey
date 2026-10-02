/**
 * After PayPal approves in its window, the page must never go back to "you
 * have not been charged": the subscription exists at PayPal and activates from
 * its webhook. Only PayPal's own "not confirmed" stops the wait.
 */

import { describe, expect, it } from 'vitest';
import { afterApproval, afterPolling, unconfirmedMessage } from '@/lib/approval-outcome';

const UNCONFIRMED_MESSAGE = unconfirmedMessage('PayPal');

describe('afterPolling', () => {
  it('keeps a buyer whose approval landed after the link expired on the page, never reloading into "expired"', () => {
    expect(afterApproval({ ok: false, errorCode: 'CHECKOUT_SESSION_EXPIRED' })).toBe('wait_for_webhook');
    expect(afterPolling('expired')).toBe('unconfirmed');
  });

  it('sends the buyer back to the app when the webhook is only late', () => {
    expect(afterPolling('confirming')).toBe('finish');
    expect(afterPolling(undefined)).toBe('finish');
  });
});

describe('afterApproval', () => {
  it('waits for the webhook on success and on every failure that is not a PayPal refusal', () => {
    expect(afterApproval({ ok: true, errorCode: null })).toBe('wait_for_webhook');
    for (const errorCode of ['unavailable', 'CHECKOUT_CONFIRMATION_LIMIT', 'origin', 'CHECKOUT_MODE_MISMATCH', null]) {
      expect(afterApproval({ ok: false, errorCode }), String(errorCode)).toBe('wait_for_webhook');
    }
    expect(afterApproval(null)).toBe('wait_for_webhook');
  });

  it('stops only when PayPal does not confirm, and even then never claims no charge', () => {
    expect(afterApproval({ ok: false, errorCode: 'CHECKOUT_CONFIRMATION_REFUSED' })).toBe('unconfirmed');
    expect(UNCONFIRMED_MESSAGE).not.toMatch(/not been charged/i);
    expect(UNCONFIRMED_MESSAGE).toMatch(/do not pay again/i);
  });
});
