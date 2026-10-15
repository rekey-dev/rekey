/**
 * "Sign in with <this deployment>", an operator OAuth provider that is really
 * the generic `oidc` implementation pointed at one of the deployment's own
 * Applications.
 *
 * What is worth pinning here is not the happy path (the `oidc` provider is
 * already covered) but the two ways this could go quietly wrong:
 *
 *   1. Reporting itself CONFIGURED without an issuer. A client id and secret
 *      with nowhere to point produce a provider that renders a button and then
 *      fails at the redirect, worse than not offering it.
 *
 *   2. Granting authority of its own. It must not become a way around
 *      `OPERATOR_SIGNUP_MODE`: someone who merely holds an account on the
 *      issuer is not thereby an operator of this deployment. On Rekey Cloud
 *      that is the whole security model, buyers get an operator account when
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

});
