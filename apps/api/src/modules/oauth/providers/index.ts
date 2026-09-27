/**
 * OAuth provider registry. Single chokepoint, routes look up the named
 * provider here; tests inject mock providers by calling
 * `registerOAuthProvider` before booting the app under test.
 *
 * Adding a provider:
 *   1. Drop a file in this directory implementing OAuthProvider.
 *   2. Register it below.
 *   3. (Optional) Add a label to the panel's OAuth UI provider list.
 *
 * `oidc` is special: it's a single registered instance that drives ANY
 * OIDC issuer at runtime by reading `config.issuerUrl` per Application.
 * Use it for Okta / Auth0 / Keycloak / Authentik / single-tenant Azure /
 * self-hosted GitLab / Cognito, anything that publishes
 * `/.well-known/openid-configuration`.
 */

import type { OAuthProvider, BuildAuthUrlInput } from './types.js';
import { GoogleProvider } from './google.js';
import { GithubProvider } from './github.js';
import { MicrosoftProvider } from './microsoft.js';
import { DiscordProvider } from './discord.js';
import { GitlabProvider } from './gitlab.js';
import { SlackProvider } from './slack.js';
import { OidcProvider } from './oidc.js';

const registry = new Map<string, OAuthProvider>();
registry.set('google', new GoogleProvider());
registry.set('github', new GithubProvider());
registry.set('microsoft', new MicrosoftProvider());
registry.set('discord', new DiscordProvider());
registry.set('gitlab', new GitlabProvider());
registry.set('slack', new SlackProvider());
registry.set('oidc', new OidcProvider());

export function getOAuthProvider(name: string): OAuthProvider | null {
  return registry.get(name) ?? null;
}

/** Tests inject mocks via this. Production code should never call it. */
export function registerOAuthProvider(provider: OAuthProvider): void {
  registry.set(provider.name, provider);
}

/**
 * Names of all registered providers, in stable declaration order. Used by
 * the panel to render the "add OAuth provider" picker without hardcoding.
 */
export function listOAuthProviderNames(): string[] {
  return Array.from(registry.keys());
}

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  google: 'Google',
  github: 'GitHub',
  microsoft: 'Microsoft',
  discord: 'Discord',
  gitlab: 'GitLab',
  slack: 'Slack',
  // The generic provider fronts whatever issuer the operator pointed it at, so
  // it cannot name the brand. "SSO" is what a user expects on that button.
  oidc: 'SSO',
};

/**
 * The name a sign-in button shows for a provider, e.g. `"GitHub"`.
 *
 * @example
 * ```ts
 * oauthProviderDisplayName('github'); // "GitHub"
 * ```
 */
export function oauthProviderDisplayName(name: string): string {
  return DISPLAY_NAMES[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Async-aware auth URL builder. The `oidc` provider needs to fetch its
 * issuer's discovery doc to compute the auth URL; static providers don't.
 * One async chokepoint here keeps callers simple.
 */
export async function buildAuthUrl(provider: OAuthProvider, input: BuildAuthUrlInput): Promise<string> {
  if (provider.name === 'oidc') {
    return (provider as OidcProvider).buildAuthUrlAsync(input);
  }
  return provider.buildAuthUrl(input);
}

export type { OAuthProvider, OAuthProviderConfig, OAuthIdentityResult } from './types.js';
