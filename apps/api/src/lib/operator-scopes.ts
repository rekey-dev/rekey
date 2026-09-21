/**
 * The operator scope registry, the one vocabulary of what a workspace member
 * may do, and the only place it is defined.
 *
 * ## Why a registry and not a column per domain, or free strings
 *
 * A column per domain needs a migration to add a domain. Free strings cannot
 * be validated at the boundary and drift from the routes silently. A closed
 * const, validated on input and grown by editing this file, is the same shape
 * `OPERATOR_TOKEN_SCOPES` already has (`lib/operator-token.ts`): the *shape*
 * is generic, the *set* is closed and versioned with the code.
 *
 * ## Seven domains, deliberately coarse
 *
 * Merge aggressively; split only when somebody needs it. `LINEAGE` is what
 * makes splitting safe later: a stored scope is never invalidated by a
 * registry change, and a genuinely new domain is held by nobody until an
 * admin grants it. Growth never widens anyone's access silently.
 *
 * ## `write` implies `read`, and there is no write-without-read
 *
 * Every write route echoes what it mutated (`return { success: true, data:
 * updated }`), so a write-only scope would leak the read through every
 * response regardless. Two levels, not four.
 *
 * ## What is NOT in here, on purpose
 *
 * Anything that changes who-may-do-what, grants, roles, invitations, the
 * membership's own scopes, and the destructive floors (lifecycle,
 * impersonation, DSAR export, erase). Those stay behind `requireTenantRole`
 * and no scope unlocks them. `team:write` on a member would let them grant
 * themselves everything and then rewrite their own scopes; keeping it out of
 * the vocabulary is what makes that impossible rather than merely forbidden.
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

export const SCOPE_LEVELS = ['read', 'write'] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

export type Scope = `${ScopeDomain}:${ScopeLevel}`;

export const ALL_SCOPES: readonly Scope[] = SCOPE_DOMAINS.flatMap((d) =>
  SCOPE_LEVELS.map((l) => `${d}:${l}` as Scope),
);

const SCOPE_SET: ReadonlySet<string> = new Set(ALL_SCOPES);

/** True if `value` is a scope this registry knows. Lineage is NOT applied here, see `expandScopes`. */
export function isScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

export function parseScope(scope: Scope): { domain: ScopeDomain; level: ScopeLevel } {
  const i = scope.indexOf(':');
  return { domain: scope.slice(0, i) as ScopeDomain, level: scope.slice(i + 1) as ScopeLevel };
}

/**
 * Old domain → the domains it split into.
 *
 * When `developer` one day splits into `api-keys` / `webhooks` / `email`, an
 * entry here (`developer: ['api-keys', 'webhooks', 'email']`) makes every
 * stored `developer:write` resolve to all three. Existing holders keep what
 * they had; the split is additive for them and default-deny for anyone who
 * never held the parent. Empty until the first split.
 */
export const SCOPE_LINEAGE: Readonly<Record<string, readonly ScopeDomain[]>> = {};

/**
 * Resolve stored scopes into the current registry: apply lineage, drop
 * anything unknown, and add the implied `read` for every `write`.
 *
 * Unknown values are dropped HERE because this is the read path over data
 * already in the database, a stale row must not break every request. On the
 * WRITE path (`PATCH /members/:id`) unknown values are refused with 400
 * instead; see `assertValidScopes`.
 */
export function expandScopes(stored: readonly string[]): ReadonlySet<Scope> {
  const out = new Set<Scope>();
  for (const raw of stored) {
    const i = raw.indexOf(':');
    if (i < 0) continue;
    const domain = raw.slice(0, i);
    const level = raw.slice(i + 1);
    if (level !== 'read' && level !== 'write') continue;
    const domains: readonly string[] = SCOPE_LINEAGE[domain] ?? [domain];
    for (const d of domains) {
      const s = `${d}:${level}`;
      if (!isScope(s)) continue;
      out.add(s);
      if (level === 'write') out.add(`${d}:read` as Scope);
    }
  }
  return out;
}

/** Every scope in the registry, as the resolved set an unrestricted member holds. */
export const UNRESTRICTED: ReadonlySet<Scope> = new Set(ALL_SCOPES);

/**
 * Does a held set satisfy a needed scope? `write` satisfies `read` because
 * `expandScopes` already added the implied read, so this is a plain lookup.
 */
export function scopeSatisfies(held: ReadonlySet<Scope>, needed: Scope): boolean {
  return held.has(needed);
}

/**
 * Validate scopes arriving from an operator (the write path). Returns the
 * offending entries rather than throwing, so the route can name them in the
 * error it builds. Lineage names are NOT accepted as input: an admin editing a
 * member today should be offered today's vocabulary, not last year's.
 */
export function invalidScopes(input: readonly string[]): string[] {
  return input.filter((s) => !isScope(s));
}

/**
 * The three existing grant roles, as the scope sets they always meant.
 *
 * `APP_BILLING` excluding `auth-config` is not new behaviour: it is
 * `redactApplicationForBilling` given a name. `APP_BILLING` gaining
 * `billing:write` on provider credentials and refunds IS a change, those
 * were `write` today, so the "billing manager" could do neither. It is the
 * change this model exists to make, and it is called out in the release note
 * rather than arriving as a side effect.
 */
export function presetScopes(role: 'APP_ADMIN' | 'APP_BILLING' | 'APP_VIEWER'): ReadonlySet<Scope> {
  switch (role) {
    case 'APP_ADMIN':
      return UNRESTRICTED;
    case 'APP_VIEWER':
      return new Set(SCOPE_DOMAINS.map((d) => `${d}:read` as Scope));
    case 'APP_BILLING':
      return new Set<Scope>([
        'billing:read',
        'billing:write',
        ...SCOPE_DOMAINS.filter((d) => d !== 'billing' && d !== 'auth-config').map(
          (d) => `${d}:read` as Scope,
        ),
      ]);
  }
}

/** Intersection, the effective set for an application request. Neither side can widen the other. */
export function intersectScopes(a: ReadonlySet<Scope>, b: ReadonlySet<Scope>): ReadonlySet<Scope> {
  const out = new Set<Scope>();
  for (const s of a) if (b.has(s)) out.add(s);
  return out;
}

/**
 * Resolve what a membership row stores into the set the gate reads.
 *
 * Two columns rather than one nullable array, because Prisma list fields
 * cannot be null. `scopesRestricted: false`, every pre-existing row, and the
 * default for every new one, resolves to the whole registry, which is what a
 * member has today. `true` with `[]` is a parked member: holds grants, reaches
 * nothing through them.
 */
export function resolveMembershipScopes(
  restricted: boolean,
  stored: readonly string[],
): ReadonlySet<Scope> {
  return restricted ? expandScopes(stored) : UNRESTRICTED;
}

/**
 * A personal access token's scopes, in this vocabulary.
 *
 *   read                → every domain, read
 *   applications:write  → every domain, write
 *   keys:mint           → developer:write
 *
 * The auth middleware intersects this with the holder's membership scopes, so
 * a token can only ever narrow what its holder may do, the principle
 * `operator-tokens.routes.ts` states and that used to be enforced only by
 * re-checking the role.
 */
export function patTokenScopes(tokenScopes: readonly string[]): ReadonlySet<Scope> {
  const out = new Set<Scope>();
  const all = (level: ScopeLevel): void => {
    for (const d of SCOPE_DOMAINS) out.add(`${d}:${level}` as Scope);
  };
  if (tokenScopes.includes('read')) all('read');
  if (tokenScopes.includes('applications:write')) {
    all('read');
    all('write');
  }
  if (tokenScopes.includes('keys:mint')) {
    out.add('developer:read');
    out.add('developer:write');
  }
  return out;
}

/**
 * An OAuth MCP token's authority in this vocabulary. `mcp:operator:write`
 * maps to every write; without it the token reads only. Admin tools stay
 * role-and-`canAdmin`-gated, they are floors, not scopes.
 */
export function mcpTokenScopes(canWrite: boolean): ReadonlySet<Scope> {
  return canWrite ? UNRESTRICTED : new Set(SCOPE_DOMAINS.map((d) => `${d}:read` as Scope));
}

/**
 * The default when a request reaches a scope consumer without
 * `req.tenantScopes` set. Every auth path sets it and the scope tests
 * exercise all of them, so a fourth path that forgot would fail those tests
 * rather than fail open in production: a MEMBER with no scopes, not an
 * unrestricted caller. The same default REST and the operator MCP route use.
 */
export const NO_SCOPES: ReadonlySet<Scope> = new Set();
