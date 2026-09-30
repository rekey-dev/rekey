/**
 * The portal's sign-in page used to answer every failure with "Check your email
 * and password and try again", including the lockout the API reports with a
 * `retryAfterSeconds`. A locked-out customer was told to keep retrying, which
 * cannot work until the lock expires.
 */

import { describe, expect, it } from 'vitest';
import {
  forgotPasswordErrorCopy,
  mfaErrorCopy,
  parseRetryAfter,
  resetPasswordErrorCopy,
  retryQuery,
  signInErrorCopy,
} from '@/lib/auth-error-copy';

const CREDENTIALS = 'Could not sign in. Check your email and password and try again.';

describe('signInErrorCopy', () => {
  it('keeps the one credential line for a wrong email or password', () => {
    expect(signInErrorCopy('INVALID_CREDENTIALS')).toBe(CREDENTIALS);
  });

  it('tells a locked-out customer to wait, with the minutes the API gave', () => {
    const copy = signInErrorCopy('TOO_MANY_FAILED_ATTEMPTS', 900);
    expect(copy).not.toBe(CREDENTIALS);
    expect(copy).toContain('about 15 minutes');
    expect(copy).not.toMatch(/check your email and password/i);
  });

  it('tells a rate-limited customer to wait, rounding seconds up to minutes', () => {
    expect(signInErrorCopy('RATE_LIMITED', 61)).toContain('about 2 minutes');
    expect(signInErrorCopy('RATE_LIMITED', 30)).toContain('about a minute');
    expect(signInErrorCopy('RATE_LIMITED', 7200)).toContain('about 2 hours');
  });

  it('still says to wait when the redirect carried no retry time', () => {
    expect(signInErrorCopy('TOO_MANY_FAILED_ATTEMPTS')).toContain('a few minutes');
  });

  it('does not blame the password for a service or setup failure', () => {
    for (const code of [
      'PASSWORD_VERIFY_BUSY',
      'DEPENDENCY_UNAVAILABLE',
      'INTERNAL_ERROR',
      'NETWORK_ERROR',
      'REQUEST_TIMEOUT',
      'HTTP_502',
      'PUBLISHABLE_KEY_INVALID',
      'ORIGIN_NOT_ALLOWED',
      'AUTH_METHOD_DISABLED',
    ]) {
      const copy = signInErrorCopy(code);
      expect(copy, code).not.toBe(CREDENTIALS);
      expect(copy, code).toContain('not a problem with your account');
    }
  });

  it('points an unconfirmed address at its inbox', () => {
    expect(signInErrorCopy('EMAIL_NOT_VERIFIED')).toMatch(/confirm/i);
  });

  it('tells a banned customer to contact the business, on either step, without blaming the password', () => {
    for (const copy of [signInErrorCopy('END_USER_BANNED'), mfaErrorCopy('END_USER_BANNED')]) {
      expect(copy).toMatch(/cannot sign in/);
      expect(copy).toMatch(/Contact the business/);
      expect(copy).not.toMatch(/password/);
    }
  });

  it('never blames the password for a code it does not recognise', () => {
    const copy = signInErrorCopy('SOME_FUTURE_CODE');
    expect(copy).not.toMatch(/password/i);
  });
});

describe('mfaErrorCopy', () => {
  it('keeps the existing code and expiry lines', () => {
    expect(mfaErrorCopy('MFA_CODE_INVALID')).toMatch(/didn.t verify/);
    expect(mfaErrorCopy('MFA_CHALLENGE_INVALID')).toMatch(/expired/);
  });

  it('tells a double-submitter to wait for the next code, or to sign in again', () => {
    expect(mfaErrorCopy('MFA_CODE_REUSED')).toMatch(/already used.*next code/);
    expect(mfaErrorCopy('MFA_CHALLENGE_USED')).toMatch(/already completed.*sign in again/);
  });

  it('does not call a rate limit a wrong code', () => {
    const copy = mfaErrorCopy('RATE_LIMITED', 120);
    expect(copy).not.toMatch(/didn.t verify/);
    expect(copy).toContain('about 2 minutes');
  });

  it('does not call a service failure a wrong code', () => {
    expect(mfaErrorCopy('INTERNAL_ERROR')).not.toMatch(/didn.t verify/);
  });

  // Only the API's own code may say a backup code was used; a plain wrong code
  // keeps the generic line, so the page never claims more than the API did.
  it('names a spent backup code and asks for another one', () => {
    const copy = mfaErrorCopy('MFA_BACKUP_CODE_USED');
    expect(copy).toMatch(/backup code was already used/);
    expect(copy).toMatch(/different backup code/);
    expect(copy).not.toMatch(/current code from your app/);
    expect(mfaErrorCopy('MFA_CODE_INVALID')).not.toMatch(/backup code was already used/);
  });
});

describe('a dead MFA challenge on the sign-in page', () => {
  it('reads as "sign in again", not as a wrong password', () => {
    expect(signInErrorCopy('MFA_CHALLENGE_INVALID')).toMatch(/expired.*sign in again/);
    expect(signInErrorCopy('MFA_CHALLENGE_USED')).toMatch(/already completed.*sign in again/);
    expect(signInErrorCopy('MFA_CHALLENGE_USED')).not.toBe(signInErrorCopy('INVALID_CREDENTIALS'));
  });
});

describe('forgotPasswordErrorCopy', () => {
  it('asks for the email when it was missing', () => {
    expect(forgotPasswordErrorCopy('missing')).toMatch(/email/i);
  });

  it('says to wait on a rate limit instead of claiming a link was sent', () => {
    expect(forgotPasswordErrorCopy('RATE_LIMITED', 600)).toContain('about 10 minutes');
  });

  it('says the link was not sent on a service failure', () => {
    expect(forgotPasswordErrorCopy('HTTP_503')).toMatch(/could not send/i);
  });
});

describe('resetPasswordErrorCopy', () => {
  it('names the codes the API actually sends', () => {
    expect(resetPasswordErrorCopy('PASSWORD_TOO_SHORT')).toMatch(/longer/i);
    expect(resetPasswordErrorCopy('PASSWORD_RESET_TOKEN_USED')).toMatch(/already used/i);
    expect(resetPasswordErrorCopy('PASSWORD_RESET_TOKEN_EXPIRED')).toMatch(/expired/i);
    expect(resetPasswordErrorCopy('PASSWORD_BREACHED')).toMatch(/breach/i);
  });

  it('says to wait on a rate limit', () => {
    expect(resetPasswordErrorCopy('RATE_LIMITED', 60)).toContain('about a minute');
  });
});

describe('retry round trip', () => {
  it('carries a positive retry time through the redirect and back', () => {
    expect(retryQuery(900)).toBe('&retry=900');
    expect(parseRetryAfter('900')).toBe(900);
  });

  it('drops a missing, zero, malformed, or absurd value', () => {
    expect(retryQuery(undefined)).toBe('');
    expect(retryQuery(0)).toBe('');
    for (const raw of [undefined, '', '0', '-5', 'abc', '1e9', '12.5', ['60']]) {
      expect(parseRetryAfter(raw), String(raw)).toBeUndefined();
    }
  });
});

describe('copy style', () => {
  it('uses no em dashes', () => {
    const all = [
      ...['INVALID_CREDENTIALS', 'TOO_MANY_FAILED_ATTEMPTS', 'RATE_LIMITED', 'INTERNAL_ERROR', 'EMAIL_NOT_VERIFIED', 'DEVICE_BLOCKED', 'X'].map(
        (c) => signInErrorCopy(c, 120),
      ),
      ...['MFA_CODE_INVALID', 'MFA_CHALLENGE_INVALID', 'RATE_LIMITED', 'X'].map((c) => mfaErrorCopy(c)),
      ...['missing', 'RATE_LIMITED', 'X'].map((c) => forgotPasswordErrorCopy(c)),
      ...['PASSWORD_TOO_SHORT', 'PASSWORD_BREACHED', 'PASSWORD_RESET_TOKEN_INVALID', 'X'].map((c) =>
        resetPasswordErrorCopy(c),
      ),
    ];
    for (const text of all) expect(text).not.toContain('\u2014');
  });
});
