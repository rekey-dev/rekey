import { describe, it, expect } from 'vitest';
import { LOGIN_ERROR_MESSAGES, loginErrorCode } from '@/app/login/error-messages';
import { SIGN_UP_ERROR_MESSAGES, signUpErrorCode } from '@/app/sign-up/error-messages';
import { API_URL_MISSING_MESSAGES } from '@/lib/error-code';

/**
 * A panel started without REKEY_URL fails every call with PANEL_API_URL_MISSING
 * before it reaches the API. Sign-in and sign-up folded that into "try again",
 * which cannot help: only the person running the panel can fix it, and they are
 * the one looking at this form.
 */
describe('PANEL_API_URL_MISSING copy', () => {
  it('has its own line naming the setting, on the sign-in page', () => {
    expect(loginErrorCode('PANEL_API_URL_MISSING')).toBe('PANEL_API_URL_MISSING');
    expect(LOGIN_ERROR_MESSAGES.PANEL_API_URL_MISSING).toContain('REKEY_URL');
  });

  it('has its own line naming the setting, on the sign-up page', () => {
    expect(signUpErrorCode('PANEL_API_URL_MISSING')).toBe('PANEL_API_URL_MISSING');
    expect(SIGN_UP_ERROR_MESSAGES.PANEL_API_URL_MISSING).toContain('REKEY_URL');
  });

  it('says the panel cannot reach its API, without em dashes', () => {
    const text = API_URL_MISSING_MESSAGES.PANEL_API_URL_MISSING;
    expect(text).toMatch(/cannot reach its API/);
    expect(text).not.toContain('\u2014');
  });
});
