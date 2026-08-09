/**
 * A caller must not choose where an auth-token email points.
 *
 * The reset, magic-link and verification routes accept a `{token}` template
 * from the caller and render it into an `<a href>` in a message WE send, with
 * our branding and our SPF/DKIM. The URL was validated only for being
 * parseable, and all three accept the PUBLISHABLE key — public by design, and
 * served unauthenticated by the portal config endpoint.
 *
 * So anyone could have us mail a victim a genuine, correctly-branded,
 * deliverable message whose button carried a live single-use session token to
 * a domain they controlled. Every signal a careful user checks said the mail
 * was legitimate, because it was.
 */
import { describe, expect, it } from 'vitest';
import { assertAllowedTokenUrl } from '../src/lib/app-url.js';

const app = (authConfig: Record<string, unknown>) => ({ authConfig });

const registered = app({
  appUrl: 'https://app.example.com',
  redirectUrls: ['https://staging.example.com/auth/callback'],
});

describe('an email link may only point at an origin the Application declared', () => {
  it('refuses an attacker-controlled origin — the takeover primitive', () => {
    expect(() =>
      assertAllowedTokenUrl(registered, 'https://attacker.tld/c?t={token}', 'signInUrl'),
    ).toThrow(/has not registered/);
  });

  it('allows the declared app URL and any registered redirect origin', () => {
    expect(() =>
      assertAllowedTokenUrl(registered, 'https://app.example.com/reset?t={token}', 'resetUrl'),
    ).not.toThrow();
    // Compared by ORIGIN, so per-environment paths need no separate entry.
    expect(() =>
      assertAllowedTokenUrl(registered, 'https://staging.example.com/anything', 'resetUrl'),
    ).not.toThrow();
  });

  it('refuses a lookalike host — origin equality, not a prefix match', () => {
    expect(() =>
      assertAllowedTokenUrl(registered, 'https://app.example.com.attacker.tld/x', 'signInUrl'),
    ).toThrow(/has not registered/);
  });

  it('refuses a non-http scheme', () => {
    for (const u of ['javascript:alert(1)', 'data:text/html,x']) {
      expect(() => assertAllowedTokenUrl(registered, u, 'signInUrl')).toThrow(/http\(s\)/);
    }
  });

  it('fails closed when the Application has declared nothing', () => {
    // Nothing to compare against is not a reason to allow everything.
    expect(() =>
      assertAllowedTokenUrl(app({}), 'https://anywhere.tld/x', 'signInUrl'),
    ).toThrow(/has not registered/);
  });

  it('a malformed stored value allows nothing rather than everything', () => {
    expect(() =>
      assertAllowedTokenUrl(app({ appUrl: 'not a url' }), 'https://anywhere.tld/x', 'resetUrl'),
    ).toThrow(/has not registered/);
  });

  it('omitting the URL entirely is still fine — the server resolves its own', () => {
    expect(() => assertAllowedTokenUrl(registered, undefined, 'signInUrl')).not.toThrow();
  });
});
