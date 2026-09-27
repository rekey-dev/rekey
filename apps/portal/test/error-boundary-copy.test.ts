/**
 * A crash on the sign-in page used to tell the customer that "nothing has been
 * charged or changed", as though a payment had been in flight. That reassurance
 * belongs on the account dashboard, the one page that shows billing.
 */

import { describe, expect, it } from 'vitest';
import { boundaryCopy, isAccountPage } from '@/lib/error-boundary-copy';

describe('boundaryCopy', () => {
  it('reassures about charges on the account dashboard', () => {
    expect(isAccountPage('/acme')).toBe(true);
    expect(boundaryCopy('/acme').body).toMatch(/charged/);
  });

  it('does not mention charges on the sign-in and password pages', () => {
    for (const path of ['/acme/login', '/acme/forgot-password', '/acme/reset-password', '/', null]) {
      expect(isAccountPage(path), String(path)).toBe(false);
      expect(boundaryCopy(path).body, String(path)).not.toMatch(/charg|payment|bought/i);
    }
  });

  it('uses no em dashes', () => {
    for (const path of ['/acme', '/acme/login']) {
      const { title, body } = boundaryCopy(path);
      expect(title + body).not.toContain('\u2014');
    }
  });
});
