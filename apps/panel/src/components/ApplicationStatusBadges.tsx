import * as React from 'react';
import { Badge } from './Badge';
import { authConfigVisible, portalDomainUnverified, signInReachable } from '@/lib/auth-config';
import type { ApplicationRow } from '@/lib/api';

/**
 * The states that stop an application serving its end-users, for the list row.
 *
 * Three of them, in descending order of "nobody is getting in":
 *
 *   1. DISABLED — `Application.disabledAt`, set through the disable/enable
 *      routes. The application refuses every end-user request at both API-key
 *      middlewares, serves no hosted portal and sends no mail. It is the
 *      reversible stand-in for the delete Rekey does not have, so on a list it
 *      is the single most important fact about a row.
 *   2. NO SIGN-IN — no auth method and no OAuth provider, so nobody can get in
 *      even though the application is live. Always a half-finished setup: no
 *      application is created in this state.
 *   3. PORTAL UNVERIFIED — the hosted portal is on and pinned to a custom
 *      domain DNS has not verified, so that hostname does not serve.
 *
 * All three read fields the list payload already carries, so this adds no
 * request to a page that already makes several.
 *
 * ## What is deliberately NOT here
 *
 * Configuration is not a fault. `signupMode` is the temptation — it is right
 * there in the same object — but `invite_only` is a posture the quickstart
 * actively recommends and `secret_only` is what every server-side integration
 * runs, so both would paint an identical chip on EVERY row of a workspace that
 * chose them, carrying no information that distinguishes one row from another.
 * The chip that means "look here" and the chip that means "this is how you
 * configured it" cannot share a slot: at 25 rows a page the first stops being
 * visible. The Auth tab is where a posture belongs, and it already says it.
 *
 * A healthy application therefore gets NO badge from this component, and the
 * environment badge stays the only chip on a normal row.
 *
 * ## Tone
 *
 * `StatusPill` holds the canonical tone vocabulary: danger is "a failure or a
 * revocation… never for things that merely ended", and colouring a deliberate
 * state red "trains operators to ignore red". So only NO SIGN-IN is danger — it
 * is the one an operator did not choose. A freeze is warning, matching the
 * banner the application's own layout already shows for the identical fact:
 * nothing has failed and nothing is lost, but on a list it is unusual enough
 * that you may have forgotten it.
 */
export function ApplicationStatusBadges({
  app,
}: {
  app: Pick<
    ApplicationRow,
    | 'authConfig'
    | 'oauthConfig'
    | 'disabledAt'
    | 'disabledReason'
    | 'hostedPortalEnabled'
    | 'portalDomain'
    | 'portalDomainVerifiedAt'
  >;
}): React.JSX.Element | null {
  const badges: React.JSX.Element[] = [];

  // Frozen outranks everything and is reported alone. A disabled application
  // refuses all end-user traffic regardless of how anything else is configured,
  // so the rest is true but irrelevant, and stacking chips buries the one that
  // matters.
  //
  // Deliberately OUTSIDE the redaction guard below. `redactApplicationForBilling`
  // blanks `authConfig`/`oauthConfig` and nothing else, so `disabledAt` is
  // present for every audience — and a billing manager looking at a workspace
  // that has stopped taking money is exactly who needs to see a freeze.
  if (app.disabledAt) {
    return (
      <Badge tone="warning" dot title={app.disabledReason ?? undefined}>
        Disabled
      </Badge>
    );
  }

  if (portalDomainUnverified(app)) {
    badges.push(
      <Badge key="portal-unverified" tone="warning" dot>
        Portal domain unverified
      </Badge>,
    );
  }

  // Everything below reads the auth config, so it stays silent when that was
  // redacted away rather than reporting "configured with nothing".
  if (authConfigVisible(app) && !signInReachable(app)) {
    badges.push(
      <Badge key="no-sign-in" tone="danger" dot>
        No sign-in
      </Badge>,
    );
  }

  if (badges.length === 0) return null;
  return <>{badges}</>;
}
