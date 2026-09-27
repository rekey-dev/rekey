import { describe, it, expect } from 'vitest';
import { LOGIN_ERROR_MESSAGES, loginErrorCode } from '@/app/login/error-messages';
import { UNKNOWN_ERROR_CODE } from '@/lib/error-code';

/**
 * #357.4: the login page renders only codes in its map, and the sign-in paths
 * forwarded raw API codes, so DEPENDENCY_UNAVAILABLE and any future code left
 * the operator on a plain form with no banner.
 */
describe('login error codes', () => {
  it('has copy for the codes that used to render nothing', () => {
    for (const code of ['DEPENDENCY_UNAVAILABLE', 'OPERATOR_INVITE_REQUIRED', 'OPERATOR_SIGNUP_CLOSED']) {
      expect(loginErrorCode(code)).toBe(code);
      expect(LOGIN_ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it('turns an unmapped API code into one that renders a banner', () => {
    const code = loginErrorCode('SOME_FUTURE_API_CODE');
    expect(code).toBe(UNKNOWN_ERROR_CODE);
    expect(LOGIN_ERROR_MESSAGES[code]).toBeTruthy();
  });

  it('keeps the new copy free of em dashes and first-person plural', () => {
    for (const code of ['DEPENDENCY_UNAVAILABLE', UNKNOWN_ERROR_CODE]) {
      const text = LOGIN_ERROR_MESSAGES[code]!;
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/\b(we|us|our)\b/i);
    }
  });
});
