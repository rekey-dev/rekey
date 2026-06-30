/**
 * Session + app-config helpers used by server components and server actions.
 *
 * `getSession()`     — thin re-export of @relipay/nextjs/server's auth(): reads
 *                      the httpOnly cookies, refreshes once if the access token
 *                      expired, returns `{ user, accessToken } | null`.
 * `requireSession()` — same, but redirects to /login when signed out.
 * `getAppConfig()`   — reads the Application's live config (organizationsEnabled
 *                      + billingSubject) via relipay.applications.me(). The UI is
 *                      driven from this: when billingSubject === 'org' the user
 *                      MUST be inside a team before they can check out.
 * `getActiveOrgId()` — the active-org id carried by the access token (set by
 *                      organizations.switch). Determines whether billing/usage
 *                      reads resolve against the personal pool or the org pool.
 */

import 'server-only';
import { redirect } from 'next/navigation';
import { auth, type Session } from '@relipay/nextjs/server';
import { relipay } from './relipay';
import { resolveEntitlements, type ResolvedEntitlements } from './entitlements';

export type { Session };

/** Resolve the current session from cookies (null when signed out). */
export async function getSession(): Promise<Session | null> {
  return auth();
}

/** Like getSession() but bounce to /login when there's no session. */
export async function requireSession(): Promise<Session> {
  const session = await auth();
  if (!session) redirect('/login');
  return session;
}

export interface AppConfig {
  organizationsEnabled: boolean;
  /** 'org' => billing is per-team; 'user' => per-individual. */
  billingSubject: 'org' | 'user';
  appName: string;
  appSlug: string;
}

/**
 * Read the calling Application's config. Cached per-request would be ideal in a
 * real app; here it's a single network call and Next dedupes within a render.
 */
export async function getAppConfig(): Promise<AppConfig> {
  const me = await relipay.applications.me();
  return {
    organizationsEnabled: me.authConfig.organizationsEnabled,
    billingSubject: (me.billingConfig.billingSubject as 'org' | 'user') ?? 'user',
    appName: me.name,
    appSlug: me.slug,
  };
}

/**
 * The active organization id encoded in the session's access token, or null
 * for the personal workspace. `getCurrentUser` surfaces it as
 * `activeOrganizationId`.
 */
export async function getActiveOrgId(accessToken: string): Promise<string | null> {
  const user = await relipay.auth.getCurrentUser(accessToken);
  return user.activeOrganizationId ?? null;
}

/**
 * Everything a signed-in page's chrome needs in one server round-trip set:
 * the session, app config, active org (+ its name), and resolved entitlements.
 * Drives the AppShell badges and the org-billing gate.
 */
export interface WorkspaceContext {
  session: Session;
  config: AppConfig;
  activeOrgId: string | null;
  activeOrgName: string | null;
  entitlements: ResolvedEntitlements;
  /** True when the app bills per-org AND the user isn't inside a team yet. */
  orgGateBlocking: boolean;
  workspaceLabel: string;
  planLabel: string;
}

export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  const session = await requireSession();
  const config = await getAppConfig();
  const activeOrgId = await getActiveOrgId(session.accessToken);

  let activeOrgName: string | null = null;
  if (activeOrgId) {
    try {
      const org = await relipay.organizations.get(session.accessToken, activeOrgId);
      activeOrgName = org.name;
    } catch {
      activeOrgName = null;
    }
  }

  const entitlements = await resolveEntitlements(session.accessToken, activeOrgId);
  const orgRequired = config.billingSubject === 'org';
  const orgGateBlocking = orgRequired && !activeOrgId;

  const workspaceLabel = activeOrgId
    ? `Team: ${activeOrgName ?? activeOrgId}`
    : orgRequired
      ? 'No team selected'
      : 'Personal';

  const planLabel = orgGateBlocking
    ? 'no team'
    : `${entitlements.maxQrs} QRs · ${entitlements.creditBalance} credits${entitlements.isPro ? ' · Pro' : ''}`;

  return {
    session,
    config,
    activeOrgId,
    activeOrgName,
    entitlements,
    orgGateBlocking,
    workspaceLabel,
    planLabel,
  };
}
