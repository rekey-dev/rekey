/**
 * What the sign-in page says when a social sign-in comes back refused. Codes
 * every sign-in shares (a suspended account, a device limit, a throttle) go
 * through `signInErrorCopy` instead; these are the ones only this path has.
 *
 * Pure and runtime-neutral.
 */

const COPY: Readonly<Record<string, (provider: string) => string>> = {
  OAUTH_STATE_MISMATCH: () =>
    'This sign-in expired or was started in another browser or tab. Start again from this page.',
  OAUTH_CANCELED: (p) => `Sign-in with ${p} was canceled. Choose a way to sign in.`,
  OAUTH_EMAIL_NOT_VERIFIED: (p) =>
    `${p} has not confirmed the email address on that account, and an account here already uses that address. ` +
    'Sign in to that account another way.',
  OAUTH_NO_EMAIL: (p) =>
    `${p} did not share an email address, so no account could be created. Allow access to your email address ` +
    `when ${p} asks, or sign in another way.`,
  OAUTH_IDENTITY_WRONG_APPLICATION: (p) => `That ${p} account belongs to a different site. Sign in another way.`,
  SIGNUP_DISABLED: (p) =>
    `There is no account here for that ${p} account, and new accounts cannot be created here. ` +
    'Sign in with the account you already have.',
  SIGNUP_REQUIRES_SECRET_KEY: (p) =>
    `There is no account here for that ${p} account, and new accounts cannot be created here. ` +
    'Sign in with the account you already have.',
  SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED: (p) =>
    `The email address on that ${p} account cannot be used to create an account here. Sign in another way.`,
  TENANT_QUOTA_EXCEEDED: () =>
    'New accounts cannot be created here right now. Contact the business that runs this site.',
  CREDENTIAL_SUPERSEDED: () => 'This sign-in was interrupted by a change to the account. Start again from this page.',
};

const UNAVAILABLE = (p: string) => `Sign-in with ${p} is not working on this site right now. Sign in another way.`;

const UNAVAILABLE_CODES = new Set([
  'OAUTH_PROVIDER_NOT_CONFIGURED',
  'OAUTH_PROVIDER_UNKNOWN',
  'OAUTH_REDIRECT_URI_NOT_ALLOWED',
  'OAUTH_TOKEN_EXCHANGE_FAILED',
  'OAUTH_ID_TOKEN_INVALID',
]);

/**
 * Whether the sign-in page should explain `code` with `socialSignInErrorCopy`
 * rather than the general sign-in copy.
 *
 * @example
 * isSocialSignInCode('OAUTH_NO_EMAIL'); // true
 * isSocialSignInCode('END_USER_BANNED'); // false
 */
export function isSocialSignInCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(COPY, code) || UNAVAILABLE_CODES.has(code);
}

/**
 * @example
 * socialSignInErrorCopy('OAUTH_CANCELED', 'Google'); // 'Sign-in with Google was canceled. Choose a way to sign in.'
 */
export function socialSignInErrorCopy(code: string, provider: string): string {
  const known = Object.prototype.hasOwnProperty.call(COPY, code) ? COPY[code] : undefined;
  return known ? known(provider) : UNAVAILABLE(provider);
}

/** The provider's display name from the list the page offers, or a neutral stand-in. */
export function providerDisplayName(providers: ReadonlyArray<{ id: string; name: string }>, id: unknown): string {
  return providers.find((p) => p.id === id)?.name ?? 'that provider';
}
