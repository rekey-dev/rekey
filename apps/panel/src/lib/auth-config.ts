import type { ApplicationRow } from './api';

/**
 * Derivations over an Application's auth configuration, shared by the surfaces
 * that display it. Pure, no rendering.
 *
 * They live together because the applications list renders THREE statements
 * about one application from the same payload — the onboarding checklist's
 * "configure an auth method" step, the row's method count, and the row's status
 * badges — and each held its own rule. For an OAuth-only application the three
 * disagreed on one screen: the checklist called it unconfigured, the row read
 * "0 auth methods", and the badges called it healthy.
 */

/**
 * Whether this payload actually contains the auth configuration, or had it
 * redacted away.
 *
 * An operator holding only the `APP_BILLING` grant receives `authConfig: {}`
 * and `oauthConfig: {}` from `redactApplicationForBilling`, on the list route
 * and on get-one. Redacted and "configured with nothing" are byte-identical
 * apart from this, and treating the first as the second reports a healthy
 * application as broken.
 *
 * `methods` is the signal, and the invariant behind it is on the WRITE paths,
 * not this one: nothing parses on the way out (`applicationsService.list`
 * returns raw Prisma rows and the response serializer is `JSON.stringify`, so
 * the raw jsonb column arrives here untouched). Every path that STORES an
 * `authConfig` puts it through `AuthConfigSchema` first, where `methods` is
 * required, so a stored config always carries it and absence means redaction.
 */
export function authConfigVisible(app: Pick<ApplicationRow, 'authConfig'>): boolean {
  return Array.isArray(app.authConfig?.methods);
}

/**
 * Can anybody sign in at all — a primary method, or an OAuth provider?
 *
 * Empty `methods` is NOT the same as "no sign-in": `AuthConfigSchema` documents
 * it as an OAuth-only application, and `updateAuthConfig` names removing
 * `password` as the way to reach that state deliberately. Both halves have to
 * be empty, which no application is born in (`DEFAULT_AUTH_CONFIG` ships
 * `methods: ['password']`), so this is always a half-finished setup.
 *
 * One rule, three callers: the badge, the onboarding checklist's "configure an
 * auth method" step, and the row's method count. They disagreed before this
 * existed — an OAuth-only application had the checklist calling it unconfigured,
 * the row reading "0 auth methods", and the badges calling it healthy, all on
 * one screen.
 */
export function signInReachable(
  app: Pick<ApplicationRow, 'authConfig' | 'oauthConfig'>,
): boolean {
  const methods = app.authConfig?.methods ?? [];
  const oauthCount = Object.keys(app.oauthConfig ?? {}).length;
  return methods.length > 0 || oauthCount > 0;
}

/**
 * A hosted portal pinned to a custom domain that DNS has not verified yet.
 *
 * `portalDomain` is only activated after verification, so this is an
 * end-user-facing outage: the portal is switched on, points at a hostname that
 * does not serve, and nothing else in the panel says so from the list.
 */
export function portalDomainUnverified(
  app: Pick<ApplicationRow, 'hostedPortalEnabled' | 'portalDomain' | 'portalDomainVerifiedAt'>,
): boolean {
  return (
    app.hostedPortalEnabled === true &&
    typeof app.portalDomain === 'string' &&
    app.portalDomain.length > 0 &&
    !app.portalDomainVerifiedAt
  );
}
