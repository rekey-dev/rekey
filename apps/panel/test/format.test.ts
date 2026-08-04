/**
 * `describeUserAgent`, the status maps, and the money/percent formatters.
 *
 * `describeUserAgent` is an ORDER-DEPENDENT regex cascade — Edge and Chrome
 * both claim "Chrome", and everything Chromium claims "Safari" — so it is
 * exactly the kind of function a well-meaning reorder silently breaks. Its
 * first branch is not cosmetic: the sessions page tells operators to "revoke
 * any you don't recognize", and the panel's own server-side fetch shows up
 * there as a bare `node`. Labelling it wrong invites an operator to revoke the
 * session they are currently using.
 */

import { describe, expect, it } from 'vitest';
import { describeUserAgent, formatMoney, formatPercent } from '@/lib/format';
import { statusLabel, statusTone } from '@/components/StatusPill';

describe('describeUserAgent', () => {
  // The branch that exists to stop an operator revoking their own session.
  it('names the panel itself and warns before the operator revokes it', () => {
    for (const ua of ['node', 'undici', 'next', 'node-fetch/2.6', 'Node/20.11.0']) {
      const d = describeUserAgent(ua);
      expect(d.label).toBe('Rekey panel (server-side)');
      expect(d.note).toMatch(/signs you out of the panel/);
    }
  });

  it('does not mistake a real browser for the panel', () => {
    const d = describeUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    );
    expect(d.label).toBe('Chrome on macOS');
    expect(d.note).toBeUndefined();
  });

  // Order dependence, stated as assertions: each of these UAs contains the
  // marker of every browser listed after it.
  it('resolves Edge before Chrome and Chrome before Safari', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0',
    ).label).toBe('Edge on Windows');

    expect(describeUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    ).label).toBe('Safari on macOS');

    expect(describeUserAgent(
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 OPR/79.0',
    ).label).toBe('Opera on Android');
  });

  it('recognises the operating systems it claims to', () => {
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1').label)
      .toBe('Safari on iOS');
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0').label)
      .toBe('Firefox on Linux');
  });

  it('degrades gracefully rather than inventing a label', () => {
    expect(describeUserAgent(null).label).toBe('Unknown device');
    expect(describeUserAgent('   ').label).toBe('Unknown device');
    expect(describeUserAgent('curl/8.4.0').label).toBe('curl/8.4.0');
    // Long unknowns are truncated, not dropped.
    const long = 'x'.repeat(120);
    expect(describeUserAgent(long).label).toHaveLength(58);
    expect(describeUserAgent(long).label.endsWith('…')).toBe(true);
  });
});

describe('status pill', () => {
  it('title-cases every underscore, not just the first', () => {
    expect(statusLabel('PAST_DUE')).toBe('Past due');
    // The bug the portal's non-global `replace('_', ' ')` had.
    expect(statusLabel('NOT_CONFIGURED')).toBe('Not configured');
    expect(statusLabel('ACTIVE')).toBe('Active');
  });

  it('keeps red for faults and grey for endings', () => {
    expect(statusTone('FAILED')).toBe('danger');
    expect(statusTone('REVOKED')).toBe('danger');
    // Not red: a customer who cancelled is not a fault, and colouring endings
    // red is how red stops meaning anything. Admin used to disagree.
    expect(statusTone('CANCELED')).toBe('neutral');
    expect(statusTone('CANCELLED')).toBe('neutral');
    expect(statusTone('EXPIRED')).toBe('neutral');
    expect(statusTone('REFUNDED')).toBe('neutral');
  });

  it('treats PAST_DUE as a warning, the same as the portal shows the customer', () => {
    expect(statusTone('PAST_DUE')).toBe('warning');
  });

  it('is case-insensitive and falls back to neutral for unknown statuses', () => {
    expect(statusTone('active')).toBe('success');
    expect(statusTone('SOMETHING_NEW')).toBe('neutral');
  });
});

describe('formatMoney', () => {
  it('renders minor units as a price', () => {
    expect(formatMoney(999, 'USD')).toMatch(/9\.99/);
    expect(formatMoney(0, 'USD')).toMatch(/0\.00/);
  });

  it('falls back to a readable string for an unknown currency code', () => {
    expect(formatMoney(999, 'XXXX')).toBe('9.99 XXXX');
  });
});

describe('formatPercent', () => {
  it('renders hundredths of a percent', () => {
    expect(formatPercent(1000)).toBe('10.00%');
  });
});
