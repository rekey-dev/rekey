import { StaticOAuth2Provider, emailFromClaims } from './_oauth2-base.js';

/**
 * Slack "Sign in with Slack" (OpenID Connect flow). Uses Slack's OIDC
 * endpoints directly so we get an id_token back.
 */
export class SlackProvider extends StaticOAuth2Provider {
  constructor() {
    super({
      name: 'slack',
      authUrl: 'https://slack.com/openid/connect/authorize',
      tokenUrl: 'https://slack.com/api/openid.connect.token',
      userInfoUrl: null,
      defaultScopes: ['openid', 'email', 'profile'],
      toIdentity: (claims) => ({
        providerAccountId: String(claims['sub'] ?? ''),
        ...emailFromClaims(claims),
      }),
    });
  }
}
