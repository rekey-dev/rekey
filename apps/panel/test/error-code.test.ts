import { describe, it, expect } from 'vitest';
import { normalizeErrorCode, UNKNOWN_ERROR_CODE } from '@/lib/error-code';

/**
 * Regression cover for the silent sign-up / password-reset failure.
 *
 * The unauthenticated pages render only `?error=` codes they have copy for, so
 * that a hand-edited link cannot paint a fake failure. Forwarding the API's raw
 * code into that scheme meant any code the page had not enumerated rendered
 * NOTHING — and the API answers `BAD_REQUEST`, not `PASSWORD_TOO_SHORT`, for a
 * password under 8 characters. Submitting one returned a blank form with no
 * message at all.
 */

// The shape of a page's message map; only the keys matter here.
const MESSAGES: Record<string, string> = {
  missing: 'All fields are required.',
  EMAIL_ALREADY_EXISTS: 'That email is already registered.',
  BAD_REQUEST: 'Check the details above.',
  [UNKNOWN_ERROR_CODE]: 'Could not create your workspace. Please try again.',
};

describe('normalizeErrorCode', () => {
  it('passes through a code the page has copy for', () => {
    expect(normalizeErrorCode('EMAIL_ALREADY_EXISTS', MESSAGES)).toBe('EMAIL_ALREADY_EXISTS');
    expect(normalizeErrorCode('missing', MESSAGES)).toBe('missing');
  });

  it('maps the code that made a short password silent onto real copy', () => {
    // The exact repro: POST sign-up with password "short" answers BAD_REQUEST.
    const code = normalizeErrorCode('BAD_REQUEST', MESSAGES);
    expect(code).toBe('BAD_REQUEST');
    expect(MESSAGES[code]).toBeTruthy();
  });

  it('falls back to a code that always has copy, never to silence', () => {
    for (const code of ['TEAPOT', 'SOME_FUTURE_API_CODE', 'VALIDATION_ERROR', '']) {
      const normalized = normalizeErrorCode(code, MESSAGES);
      expect(normalized).toBe(UNKNOWN_ERROR_CODE);
      expect(MESSAGES[normalized]).toBeTruthy();
    }
  });

  it('never lets an inherited Object property masquerade as copy', () => {
    // `'constructor' in messages` is true on a plain object literal, so a naive
    // `in` check would forward `constructor` as if the page could render it.
    expect(normalizeErrorCode('constructor', MESSAGES)).toBe(UNKNOWN_ERROR_CODE);
    expect(normalizeErrorCode('toString', MESSAGES)).toBe(UNKNOWN_ERROR_CODE);
  });

  it('still yields a renderable code when the map itself is bare', () => {
    // A page whose map lacks `unknown` is a bug, but the function must not be
    // the thing that decides to render nothing.
    expect(normalizeErrorCode('WHATEVER', {})).toBe(UNKNOWN_ERROR_CODE);
  });
});
