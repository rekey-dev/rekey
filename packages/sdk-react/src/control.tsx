/**
 * Control components — the "render this region iff …" primitives, Clerk-shaped.
 *
 * `<SignedIn>` / `<SignedOut>` already live in `components.tsx`; this module adds
 * the loading-gate pair and the entitlement/role gate `<Protect>`.
 *
 * IMPORTANT (security model): `<Protect>` does NOT fetch entitlements from the
 * API — the browser holds only the user JWT, and entitlement resolution is a
 * server concern (`@relipay/node` `billing.getEntitlements`, resolved against
 * the secret key). The customer resolves entitlements server-side and passes the
 * resolved facts down (e.g. via the provider seed, a prop, or React context of
 * their own). `<Protect>` renders a *decision the server already made*. This
 * mirrors the "entitlements always resolve server-side, never trust the browser"
 * rule the Next/QR examples established.
 */

import * as React from 'react';
import { useUser } from './hooks.js';

/**
 * The entitlement facts `<Protect>` checks against. Resolve these server-side
 * (via `@relipay/node billing.getEntitlements`) and hand them to the component.
 * All optional — pass whichever your gate needs.
 */
export interface ProtectAuthorization {
  /** Feature flags + numeric limits, keyed by code (the `features` map). */
  features?: Record<string, boolean | number | string>;
  /** The caller's role in the active organization, when org-scoped. */
  role?: string;
}

export interface ProtectProps {
  /**
   * The resolved authorization facts (server-side truth). When omitted,
   * `<Protect>` treats the user as unauthorized for any feature/role check
   * (fail-closed) — pass it from your server-resolved entitlements.
   */
  authorization?: ProtectAuthorization;
  /** Require this feature flag to be truthy (`features[feature]`). */
  feature?: string;
  /** Require one of these roles (matches `authorization.role`). */
  role?: string | string[];
  /**
   * Arbitrary predicate over the authorization facts. Use for numeric limits
   * or compound checks: `condition={(a) => Number(a.features?.max_qr_codes) > 3}`.
   */
  condition?: (auth: ProtectAuthorization) => boolean;
  /** Rendered when the check passes (and the user is signed in). */
  children: React.ReactNode;
  /** Rendered when the check fails. Defaults to nothing. */
  fallback?: React.ReactNode;
}

function roleMatches(have: string | undefined, want: string | string[] | undefined): boolean {
  if (!want) return true;
  if (!have) return false;
  const list = Array.isArray(want) ? want : [want];
  return list.includes(have);
}

/**
 * Gate UI by entitlement / feature / role. Renders `children` only when the
 * user is signed in AND every supplied check passes; otherwise renders
 * `fallback` (or nothing).
 *
 * @example Feature flag
 * ```tsx
 * <Protect authorization={{ features }} feature="analytics" fallback={<UpgradeCard />}>
 *   <AnalyticsTab />
 * </Protect>
 * ```
 *
 * @example Role
 * ```tsx
 * <Protect authorization={{ role }} role={["OWNER", "ADMIN"]}>
 *   <InviteMembersButton />
 * </Protect>
 * ```
 *
 * @example Numeric limit
 * ```tsx
 * <Protect authorization={{ features }} condition={(a) => Number(a.features?.max_qr_codes) >= 10}>
 *   <BulkTools />
 * </Protect>
 * ```
 */
export function Protect({
  authorization,
  feature,
  role,
  condition,
  children,
  fallback = null,
}: ProtectProps): React.JSX.Element | null {
  const { signedIn, loading } = useUser();
  if (loading) return null;

  const auth: ProtectAuthorization = authorization ?? {};
  let ok = signedIn;
  if (ok && feature !== undefined) {
    ok = Boolean(auth.features?.[feature]);
  }
  if (ok && role !== undefined) {
    ok = roleMatches(auth.role, role);
  }
  if (ok && condition !== undefined) {
    ok = condition(auth);
  }
  return <>{ok ? children : fallback}</>;
}

/**
 * Renders children only while the provider is resolving the session — the
 * `<ClerkLoading>` equivalent. Pair with `<RelipayLoaded>`.
 *
 * @example
 * ```tsx
 * <RelipayLoading><Spinner /></RelipayLoading>
 * <RelipayLoaded><App /></RelipayLoaded>
 * ```
 */
export function RelipayLoading({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { loading } = useUser();
  return loading ? <>{children}</> : null;
}

/** Renders children once the provider has resolved the session (the `<ClerkLoaded>` equivalent). */
export function RelipayLoaded({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { loading } = useUser();
  return loading ? null : <>{children}</>;
}
