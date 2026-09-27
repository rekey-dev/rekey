import { z } from 'zod';

// The WHATWG URL parser does the IDNA (UTS #46) mapping in Node and in every
// browser. This package compiles against ES2022 alone, so the global is
// declared here rather than pulling in DOM or Node typings.
declare const URL: new (input: string) => { hostname: string };

/** Most entries either domain list may hold. */
export const SIGNUP_DOMAIN_LIST_MAX = 500;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NOT_A_HOSTNAME_CHAR = /[\s/?#@:\\%[\]*]/;
const NON_ASCII = /[^\x20-\x7e]/;

/**
 * The lowercase ASCII form of a domain, with internationalised names converted
 * to punycode, or null when the input is not a domain name.
 *
 * @example
 * ```ts
 * normalizeDomain('Example.COM');  // 'example.com'
 * normalizeDomain('bücher.de');    // 'xn--bcher-kva.de'
 * normalizeDomain('localhost');    // null, a single label is not a domain
 * ```
 */
export function normalizeDomain(input: string): string | null {
  let domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (domain === '' || domain.length > 253 || NOT_A_HOSTNAME_CHAR.test(domain)) return null;
  if (NON_ASCII.test(domain)) {
    try {
      domain = new URL(`http://${domain}`).hostname;
    } catch {
      return null;
    }
  }
  const labels = domain.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (labels.length < 2 || /^\d+$/.test(tld)) return null;
  return labels.every((l) => LABEL.test(l)) ? domain : null;
}

/**
 * A sign-up domain rule: a bare domain (`example.com`, that domain only) or
 * `*.example.com` (any subdomain of it, not the domain itself). Any other use
 * of `*` is refused, so a rule never matches more than its author can read.
 *
 * @example
 * ```ts
 * normalizeDomainRule('*.Example.com'); // '*.example.com'
 * normalizeDomainRule('ex*ample.com');  // null
 * ```
 */
export function normalizeDomainRule(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('*.')) {
    const base = normalizeDomain(trimmed.slice(2));
    return base === null ? null : `*.${base}`;
  }
  return normalizeDomain(trimmed);
}

/**
 * Whether an already-normalised email domain is matched by a normalised rule.
 *
 * @example
 * ```ts
 * domainMatchesRule('eu.example.com', '*.example.com'); // true
 * domainMatchesRule('example.com', '*.example.com');    // false
 * ```
 */
export function domainMatchesRule(domain: string, rule: string): boolean {
  if (rule.startsWith('*.')) return domain.endsWith(rule.slice(1));
  return domain === rule;
}

const DomainRuleSchema = z
  .string()
  .max(260)
  .transform((value, ctx) => {
    const rule = normalizeDomainRule(value);
    if (rule === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${value}" is not a domain. Use a bare domain such as example.com, or *.example.com for its subdomains.`,
      });
      return z.NEVER;
    }
    return rule;
  });

const DomainListSchema = z
  .array(DomainRuleSchema)
  .max(SIGNUP_DOMAIN_LIST_MAX)
  .transform((rules) => [...new Set(rules)]);

/**
 * Which email addresses may create an end-user through self sign-up (password
 * sign-up, a magic link for a new address, or a first OAuth sign-in). Users an
 * operator creates or imports are never checked.
 *
 * A blocked domain wins over an allowed one. With `allowedDomains` non-empty,
 * every other domain is refused. `blockDisposable` refuses the throwaway-inbox
 * domains Rekey ships a list of, and their subdomains.
 *
 * @example
 * ```ts
 * SignupRestrictionsSchema.parse({ allowedDomains: ['Acme.com', '*.acme.com'] });
 * // { allowedDomains: ['acme.com', '*.acme.com'] }
 * ```
 */
export const SignupRestrictionsSchema = z
  .object({
    allowedDomains: DomainListSchema.optional(),
    blockedDomains: DomainListSchema.optional(),
    blockDisposable: z.boolean().optional(),
  })
  .strict();
export type SignupRestrictions = z.infer<typeof SignupRestrictionsSchema>;
