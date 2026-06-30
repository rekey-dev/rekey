import { StaticOAuth2Provider, emailFromClaims } from './_oauth2-base.js';

/**
 * Microsoft / Azure AD OAuth (multi-tenant `common` endpoint).
 *
 * For single-tenant Azure AD apps, the user can stick their tenant ID into
 * the `issuerUrl` and use the `oidc` provider instead.
 *
 * **Email verification.** Microsoft consumer (MSA) accounts can have an
 * unverified email alias; `email_verified` is sometimes absent from the
 * id_token. `emailFromClaims` returns `false` in that case — the
 * auto-link gate in oauth.service refuses to attach to an existing user.
 */
export class MicrosoftProvider extends StaticOAuth2Provider {
  constructor() {
    super({
      name: 'microsoft',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      userInfoUrl: null, // id_token is always returned
      defaultScopes: ['openid', 'email', 'profile'],
      extraAuthParams: { response_mode: 'query', prompt: 'select_account' },
      toIdentity: (claims) => ({
        providerAccountId: String(claims['sub'] ?? claims['oid'] ?? ''),
        ...emailFromClaims(claims),
      }),
    });
  }
}
