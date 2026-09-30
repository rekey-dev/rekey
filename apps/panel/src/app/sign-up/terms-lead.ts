/**
 * Opening of the terms line under the sign-up button. Joining through a bound
 * invite creates an account but no workspace, so it must not say it does.
 *
 * @example
 * termsLead(true); // 'By creating an account you agree to the'
 */
export function termsLead(joining: boolean): string {
  return joining ? 'By creating an account you agree to the' : 'By creating a workspace you agree to the';
}
