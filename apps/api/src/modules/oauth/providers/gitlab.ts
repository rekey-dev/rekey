import { StaticOAuth2Provider } from './_oauth2-base.js';

/**
 * GitLab OAuth (gitlab.com). For self-hosted GitLab, use the `oidc` provider.
 *
 * GitLab returns `confirmed_at` (ISO timestamp) on the user object once the
 * email is confirmed. Absent / null = unconfirmed. The auto-link gate
 * refuses to attach unverified emails to existing accounts.
 */
export class GitlabProvider extends StaticOAuth2Provider {
  constructor() {
    super({
      name: 'gitlab',
      authUrl: 'https://gitlab.com/oauth/authorize',
      tokenUrl: 'https://gitlab.com/oauth/token',
      userInfoUrl: 'https://gitlab.com/api/v4/user',
      defaultScopes: ['read_user', 'email'],
      toIdentity: (data) => {
        const email = typeof data['email'] === 'string' ? (data['email'] as string) : null;
        const emailVerified =
          typeof data['confirmed_at'] === 'string' &&
          (data['confirmed_at'] as string).length > 0 &&
          email !== null;
        return {
          providerAccountId: String(data['id'] ?? ''),
          email,
          emailVerified,
        };
      },
    });
  }
}
