/**
 * Narrow an API error code to one the page has copy for.
 *
 * The unauthenticated pages round-trip failures through `?error=<code>` and
 * render only codes present in their own message map — deliberately, because
 * `?error=` sits in the URL and an unrecognised value would otherwise let
 * anyone paint a real-looking failure onto a healthy form by editing the link.
 *
 * Forwarding the API's raw code into that scheme turns any code the page hasn't
 * enumerated into **silence**. That is not hypothetical: the API answers
 * `BAD_REQUEST` (not `PASSWORD_TOO_SHORT`) for a password under 8 characters,
 * so "create workspace" and "reset password" both came back with the password
 * blanked, no banner, and nothing to act on.
 *
 * Calling this in the action keeps both properties: a real failure always lands
 * on a code with copy, and a hand-edited `?error=` still renders nothing,
 * because `unknown` is only ever produced here.
 */
export const UNKNOWN_ERROR_CODE = 'unknown';

export function normalizeErrorCode(
  code: string,
  messages: Readonly<Record<string, string>>,
): string {
  return Object.prototype.hasOwnProperty.call(messages, code) ? code : UNKNOWN_ERROR_CODE;
}
