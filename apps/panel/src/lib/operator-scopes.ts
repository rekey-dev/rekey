/**
 * Operator scope vocabulary, mirrored from the API registry
 * (apps/api/src/lib/operator-scopes.ts). The API is the source of truth and
 * refuses anything it does not know, so drift here can only hide a control,
 * never grant a permission.
 */

export const SCOPE_DOMAINS = [
  'end-users',
  'billing',
  'auth-config',
  'developer',
  'organizations',
  'activity',
  'overview',
] as const;
export type ScopeDomain = (typeof SCOPE_DOMAINS)[number];
export type ScopeLevel = 'read' | 'write';
export type Scope = `${ScopeDomain}:${ScopeLevel}`;

/** What each domain covers, in the words an admin would use. */
export const DOMAIN_LABEL: Record<ScopeDomain, { label: string; hint: string; risk?: string }> = {
  'end-users': { label: 'End-users', hint: 'People, sessions, devices, and the support actions on them.' },
  billing: { label: 'Billing', hint: 'Plans, payments, subscriptions, credits, licences, usage, provider credentials.' },
  'auth-config': {
    label: 'Sign-in configuration',
    hint: 'Methods, OAuth providers and clients, redirect URLs, the portal.',
    risk: 'Controls how every end-user signs in.',
  },
  developer: {
    label: 'Developer',
    hint: 'API keys, webhooks, email.',
    risk: 'Write mints application secret keys, which outlive any session.',
  },
  organizations: { label: 'Organizations', hint: 'Organizations, their members, and both role catalogs.' },
  activity: { label: 'Activity', hint: 'Request logs and security events.' },
  overview: { label: 'Overview', hint: 'The dashboard tiles: counts across every domain, never amounts.' },
};

/**
 * Does a resolved scope set admit `domain:level`? `null` means unrestricted.
 * The API resolves `write` to imply `read` before it reaches the panel, so
 * this is a plain lookup.
 */
export function hasScope(scopes: readonly string[] | null | undefined, scope: Scope): boolean {
  return scopes == null || scopes.includes(scope);
}

/** The level a stored scope list holds for a domain: none, read, or write. */
export function levelFor(scopes: readonly string[] | null, domain: ScopeDomain): 'none' | ScopeLevel {
  if (scopes === null) return 'write';
  if (scopes.includes(`${domain}:write`)) return 'write';
  if (scopes.includes(`${domain}:read`)) return 'read';
  return 'none';
}
