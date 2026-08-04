/**
 * `Secure` on a session cookie must follow the REQUEST, not the build.
 *
 * The regression this pins: every cookie in the monorepo decided `Secure` with
 * `process.env.NODE_ENV === 'production'`. A deployment behind TLS whose
 * NODE_ENV was unset — or `staging`, or anything the Next build did not inline
 * as exactly `"production"` — shipped its operator and end-user session cookies
 * without `Secure`, and a browser will replay those over plain HTTP.
 */

import { describe, expect, it } from 'vitest';
import { cookieSecureFor } from '../src/cookie-security.js';

describe('cookieSecureFor', () => {
  describe('the regression itself', () => {
    it('marks Secure behind TLS regardless of any build-time env', () => {
      // The whole finding in one line: NODE_ENV is not consulted at all.
      expect(cookieSecureFor({ forwardedProto: 'https', host: 'panel.example.com' })).toBe(true);
    });

    it('marks Secure on a real host even with no forwarded proto', () => {
      // A proxy that forgets X-Forwarded-Proto must not cost the user a
      // cleartext session cookie.
      expect(cookieSecureFor({ host: 'panel.example.com' })).toBe(true);
    });

    it('marks Secure when nothing at all is known', () => {
      expect(cookieSecureFor({})).toBe(true);
    });
  });

  describe('local development still works', () => {
    it.each([
      'localhost:3031',
      'localhost',
      '127.0.0.1:3030',
      '[::1]:3050',
      '0.0.0.0:3030',
      'acme.localhost:3000',
    ])('%s is a secure context already, so no Secure flag', (host) => {
      expect(cookieSecureFor({ host })).toBe(false);
    });

    it('a proxy reporting http on loopback stays insecure', () => {
      expect(cookieSecureFor({ forwardedProto: 'http', host: 'localhost:3031' })).toBe(false);
    });

    it('https on loopback is still Secure — mkcert setups are not downgraded', () => {
      expect(cookieSecureFor({ forwardedProto: 'https', host: 'localhost:3031' })).toBe(true);
    });
  });

  describe('forwarded proto', () => {
    it('reads the FIRST hop — later hops are proxy-to-proxy', () => {
      expect(
        cookieSecureFor({ forwardedProto: 'https, http', host: 'panel.example.com' }),
      ).toBe(true);
      expect(cookieSecureFor({ forwardedProto: 'http, https', host: 'localhost:3031' })).toBe(false);
    });

    it('is case- and whitespace-insensitive', () => {
      expect(cookieSecureFor({ forwardedProto: '  HTTPS ', host: 'x.example.com' })).toBe(true);
    });

    it('a proxy reporting plain http on a REAL host still gets Secure', () => {
      // Serving a public hostname over cleartext is a deployment mistake. Fail
      // loudly (login breaks, one env var fixes it) rather than quietly
      // shipping a session credential in the clear.
      expect(cookieSecureFor({ forwardedProto: 'http', host: 'panel.example.com' })).toBe(true);
    });
  });

  describe('the insecure case is opt-in only', () => {
    it('REKEY_COOKIE_SECURE=false is the single documented escape hatch', () => {
      expect(
        cookieSecureFor({ host: 'panel.example.com', override: 'false' }),
      ).toBe(false);
    });

    it('REKEY_COOKIE_SECURE=true forces Secure even on loopback', () => {
      expect(cookieSecureFor({ host: 'localhost:3031', override: 'true' })).toBe(true);
    });

    it('a typo in the override is ignored — it never silently disables Secure', () => {
      for (const override of ['flase', 'no', '0', '', '   ', 'TRUE-ish']) {
        expect(cookieSecureFor({ host: 'panel.example.com', override })).toBe(true);
      }
    });

    it('the override is case-insensitive', () => {
      expect(cookieSecureFor({ host: 'panel.example.com', override: 'False' })).toBe(false);
      expect(cookieSecureFor({ host: 'localhost', override: 'TRUE' })).toBe(true);
    });
  });

  it('tolerates null/undefined headers without throwing', () => {
    expect(cookieSecureFor({ forwardedProto: null, host: null, override: null })).toBe(true);
    expect(cookieSecureFor({ forwardedProto: undefined, host: undefined })).toBe(true);
  });
});
