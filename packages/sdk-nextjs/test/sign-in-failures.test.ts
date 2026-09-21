/**
 * A refusal that is not about the password must not read as one.
 *
 * Two of these arrive at a sign-in form looking exactly like a typo unless
 * something reads them:
 *
 *   - `DEVICE_LIMIT_REACHED` (403) carries `details.{ limit, devices[] }`, the
 *     active machines filling the cap. That list is the entire repair path:
 *     no token was issued, so the user cannot release a device from inside the
 *     app. Dropping it leaves them at a dead end with a correct password.
 *   - `PASSWORD_VERIFY_BUSY` (503) means the bcrypt pool was saturated and the
 *     password was NOT checked. Nothing was counted toward lockout, and the
 *     credentials may be perfectly right. "Email or password is incorrect" is
 *     a false statement that sends the user to password reset.
 *
 * `RekeyError` has carried `details` and `retryAfterSeconds` all along. Nothing
 * read either one.
 */
import { describe, it, expect } from 'vitest';
import { classifySignInError } from '../src/errors.js';

/** Shaped like a decoded `RekeyError`, without importing the class. */
function apiError(fields: Record<string, unknown>): Record<string, unknown> {
  return { name: 'RekeyError', message: 'x', ...fields };
}

describe('DEVICE_LIMIT_REACHED gives the caller the devices to release', () => {
  it('reads the limit and the device list out of details', () => {
    const failure = classifySignInError(
      apiError({
        code: 'DEVICE_LIMIT_REACHED',
        details: {
          limit: 2,
          devices: [
            {
              id: 'dev_1',
              label: 'Work laptop',
              firstSeenAt: '2026-01-01T00:00:00.000Z',
              lastSeenAt: '2026-02-01T00:00:00.000Z',
            },
            { id: 'dev_2', label: null, firstSeenAt: null, lastSeenAt: null },
          ],
        },
      }),
    );

    expect(failure).toEqual({
      kind: 'device_limit',
      code: 'DEVICE_LIMIT_REACHED',
      limit: 2,
      devices: [
        {
          id: 'dev_1',
          label: 'Work laptop',
          firstSeenAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: '2026-02-01T00:00:00.000Z',
        },
        { id: 'dev_2', label: null, firstSeenAt: null, lastSeenAt: null },
      ],
    });
  });

  it('survives a details bag that is missing, malformed, or half-typed', () => {
    // This bag crosses a process boundary and is typed `unknown` for a reason.
    // A sign-in page must not crash because a field arrived as the wrong type.
    expect(classifySignInError(apiError({ code: 'DEVICE_LIMIT_REACHED' }))).toEqual({
      kind: 'device_limit',
      code: 'DEVICE_LIMIT_REACHED',
      limit: null,
      devices: [],
    });

    const messy = classifySignInError(
      apiError({
        code: 'DEVICE_LIMIT_REACHED',
        details: { limit: '2', devices: [null, 'nonsense', { label: 'no id' }, { id: 'dev_3' }] },
      }),
    );
    expect(messy).toEqual({
      kind: 'device_limit',
      code: 'DEVICE_LIMIT_REACHED',
      limit: null,
      devices: [{ id: 'dev_3', label: null, firstSeenAt: null, lastSeenAt: null }],
    });
  });
});

describe('a busy server is not a wrong password', () => {
  it('PASSWORD_VERIFY_BUSY classifies as retry_later and keeps retryAfterSeconds', () => {
    const failure = classifySignInError(
      apiError({ code: 'PASSWORD_VERIFY_BUSY', retryAfterSeconds: 2 }),
    );
    expect(failure).toEqual({
      kind: 'retry_later',
      code: 'PASSWORD_VERIFY_BUSY',
      retryAfterSeconds: 2,
    });
    // The point of the whole module: it is NOT the wrong-password arm.
    expect(failure?.kind).not.toBe('invalid_credentials');
  });

  it('a retryable code with no Retry-After still classifies as retryable', () => {
    expect(classifySignInError(apiError({ code: 'RATE_LIMITED' }))).toEqual({
      kind: 'retry_later',
      code: 'RATE_LIMITED',
      retryAfterSeconds: null,
    });
  });

  it('lockout is a wait, not a typo', () => {
    // By the time TOO_MANY_FAILED_ATTEMPTS is returned the API refuses to check
    // the password at all, even the correct one. Telling the user to try
    // harder is the one thing that cannot work.
    const failure = classifySignInError(
      apiError({ code: 'TOO_MANY_FAILED_ATTEMPTS', retryAfterSeconds: 900 }),
    );
    expect(failure).toEqual({
      kind: 'retry_later',
      code: 'TOO_MANY_FAILED_ATTEMPTS',
      retryAfterSeconds: 900,
    });
  });
});

describe('the rest of the surface', () => {
  it('names the codes a device-bound deployment produces', () => {
    expect(classifySignInError(apiError({ code: 'INVALID_CREDENTIALS' }))?.kind).toBe(
      'invalid_credentials',
    );
    expect(classifySignInError(apiError({ code: 'DEVICE_FINGERPRINT_REQUIRED' }))?.kind).toBe(
      'device_required',
    );
    expect(classifySignInError(apiError({ code: 'DEVICE_BLOCKED' }))?.kind).toBe('device_blocked');
    expect(classifySignInError(apiError({ code: 'EMAIL_NOT_VERIFIED' }))).toEqual({
      kind: 'other',
      code: 'EMAIL_NOT_VERIFIED',
    });
  });

  it('returns null for anything that is not an API error, so the caller rethrows', () => {
    // Swallowing a TypeError here is how a real crash becomes a login form
    // that silently does nothing.
    expect(classifySignInError(new TypeError('boom'))).toBeNull();
    expect(classifySignInError(undefined)).toBeNull();
    expect(classifySignInError('DEVICE_BLOCKED')).toBeNull();
    expect(classifySignInError({ code: 500 })).toBeNull();
  });

  it('works on an error that lost its prototype crossing a serialization boundary', () => {
    // A server action may hand the failure to a client component. Two installed
    // copies of shared-types would also defeat `instanceof`.
    const revived: unknown = JSON.parse(
      JSON.stringify({ code: 'DEVICE_LIMIT_REACHED', details: { limit: 1, devices: [] } }),
    );
    expect(classifySignInError(revived)?.kind).toBe('device_limit');
  });
});
