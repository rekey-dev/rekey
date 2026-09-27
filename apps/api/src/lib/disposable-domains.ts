/**
 * Throwaway-inbox domains, for `authConfig.signupRestrictions.blockDisposable`.
 *
 * The list is vendored (see disposable-domains.data.ts for its source and
 * licence) so a sign-up never waits on, or fails with, a network fetch.
 * Refresh it with `pnpm --filter @rekey.dev/api disposable:refresh`.
 */

import { DISPOSABLE_DOMAINS_TEXT } from './disposable-domains.data.js';

let domains: ReadonlySet<string> | null = null;

function disposableDomains(): ReadonlySet<string> {
  domains ??= new Set(DISPOSABLE_DOMAINS_TEXT.split('\n').filter((line) => line !== ''));
  return domains;
}

/**
 * True when `domain` (normalised, lowercase ASCII) or any parent of it is on
 * the list. Parents count because a throwaway service that owns `example.com`
 * hands out `anything.example.com` just as freely.
 *
 * @example
 * ```ts
 * isDisposableDomain('mailinator.com');     // true
 * isDisposableDomain('eu.mailinator.com');  // true
 * isDisposableDomain('gmail.com');          // false
 * ```
 */
export function isDisposableDomain(domain: string): boolean {
  const list = disposableDomains();
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
