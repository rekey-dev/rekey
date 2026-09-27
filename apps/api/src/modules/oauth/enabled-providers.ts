import type { Application } from '@prisma/client';
import type { OAuthProviderSummaryDto } from '@rekey.dev/shared-types';
import { usableProvider } from './oauth.service.js';
import { listOAuthProviderNames, oauthProviderDisplayName } from './providers/index.js';

/**
 * The OAuth providers an end-user can actually sign in with on this
 * Application, in registry order: those for which `/:provider/start` would
 * succeed (see `usableProvider`).
 *
 * Returns the id and display name and nothing else. The client id, redirect
 * URI, scopes and issuer are operator configuration, and this list is served
 * to anyone holding the publishable key.
 *
 * @example
 * ```ts
 * listEnabledOAuthProviders(application); // [{ id: 'google', name: 'Google' }]
 * ```
 */
export function listEnabledOAuthProviders(application: Application): OAuthProviderSummaryDto[] {
  return listOAuthProviderNames()
    .filter((name) => usableProvider(application, name))
    .map((name) => ({ id: name, name: oauthProviderDisplayName(name) }));
}
