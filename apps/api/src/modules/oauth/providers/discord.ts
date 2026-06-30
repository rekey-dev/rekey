import { StaticOAuth2Provider } from './_oauth2-base.js';

/**
 * Discord OAuth 2.0 — uses /users/@me to fetch identity.
 *
 * Discord uses `verified` (not `email_verified`) on the user object.
 */
export class DiscordProvider extends StaticOAuth2Provider {
  constructor() {
    super({
      name: 'discord',
      authUrl: 'https://discord.com/api/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      userInfoUrl: 'https://discord.com/api/users/@me',
      defaultScopes: ['identify', 'email'],
      extraAuthParams: { prompt: 'consent' },
      toIdentity: (data) => {
        const email = typeof data['email'] === 'string' ? (data['email'] as string) : null;
        const emailVerified = data['verified'] === true && email !== null;
        return {
          providerAccountId: String(data['id'] ?? ''),
          email,
          emailVerified,
        };
      },
    });
  }
}
