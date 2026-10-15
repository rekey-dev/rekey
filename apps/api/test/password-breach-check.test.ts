/**
 * The breached-password lookup (HIBP range API, reached through a fetch stub):
 * a known-breached password is flagged, and a network failure fails open.
 */

import { describe, expect, it } from 'vitest';
import { checkPasswordBreached } from '../src/lib/breached-password.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('breached-password check', () => {
  it('HIBP check via mocked fetch flags `password`', async () => {
    // The string "password" has SHA-1 prefix 5BAA6 and suffix
    // 1E4C9B93F3F0682250B6CF8331B7EE68FD8. Build a minimal range response.
    const fakeFetch = async (): Promise<Response> => {
      return new Response(
        '1E4C9B93F3F0682250B6CF8331B7EE68FD8:5567145\r\n' +
          '0000000000000000000000000000000000000000:1\r\n',
        { status: 200, headers: { 'content-type': 'text/plain' } },
      );
    };
    const result = await checkPasswordBreached('password', fakeFetch as unknown as typeof fetch);
    expect(result.breached).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.contacted).toBe(true);
  });

  it('HIBP check fails open on network error', async () => {
    const erroringFetch = async (): Promise<Response> => {
      throw new Error('network down');
    };
    const result = await checkPasswordBreached(
      'whatever',
      erroringFetch as unknown as typeof fetch,
    );
    expect(result.breached).toBe(false);
    expect(result.contacted).toBe(false);
  });

});
