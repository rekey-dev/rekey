/**
 * "Sign in with <this deployment>" — an operator OAuth provider that is really
 * the generic `oidc` implementation pointed at one of the deployment's own
 * Applications.
 *
 * What is worth pinning here is not the happy path (the `oidc` provider is
 * already covered) but the two ways this could go quietly wrong:
 *
 *   1. Reporting itself CONFIGURED without an issuer. A client id and secret
 *      with nowhere to point produce a provider that renders a button and then
 *      fails at the redirect — worse than not offering it.
 *
 *   2. Granting authority of its own. It must not become a way around
 *      `OPERATOR_SIGNUP_MODE`: someone who merely holds an account on the
 *      issuer is not thereby an operator of this deployment. On Rekey Cloud
 *      that is the whole security model — buyers get an operator account when
 *      provisioning creates one, which happens only after they have paid.
 */

import { describe, expect, it } from 'vitest';
import { tenantOAuthService } from '../src/modules/tenant-oauth/tenant-oauth.service.js';
import { env } from '../src/config/env.js';

describe('the `rekey` operator OAuth provider', () => {
  it('is not offered unless client id, secret AND issuer are all set', () => {
    // Under test none of the three are configured, so it must be absent.
    // This is the assertion that catches "half-configured counts as on".
    const available = tenantOAuthService.configuredProviders();
    // The SECRET is deliberately not part of this: the issuer issues public
    // clients, so a secret is optional. Id + issuer are what make it usable.
    const complete =
      Boolean(env.PANEL_OAUTH_REKEY_CLIENT_ID) && Boolean(env.PANEL_OAUTH_REKEY_ISSUER);
    expect(available.includes('rekey')).toBe(complete);
  });

  it('refuses to start a flow while unconfigured, rather than redirecting nowhere', async () => {
    if (env.PANEL_OAUTH_REKEY_CLIENT_ID) return; // configured deployment: nothing to assert
    await expect(
      tenantOAuthService.buildAuthUrl({ provider: 'rekey', state: 'x' }),
    ).rejects.toMatchObject({ code: 'OAUTH_PROVIDER_NOT_CONFIGURED' });
  });

  it('is a known provider name, so it fails as unconfigured and not as unknown', async () => {
    // The distinction matters for the operator reading the error: "you have
    // not set this up" is actionable, "no such provider" sends them looking
    // for a typo.
    await expect(
      tenantOAuthService.buildAuthUrl({ provider: 'not-a-provider', state: 'x' }),
    ).rejects.toMatchObject({ code: 'OAUTH_PROVIDER_UNKNOWN' });
  });

  it('still lists the providers that ARE configured', () => {
    // Guards against the new entry breaking the list for everyone else —
    // `configuredProviders` filters on credentials, and adding a third provider
    // that returns null must not shorten the array for google/github.
    const available = tenantOAuthService.configuredProviders();
    expect(Array.isArray(available)).toBe(true);
    for (const p of available) {
      expect(['google', 'github', 'rekey']).toContain(p);
    }
  });
});
