/**
 * /kitchen-sink — a live gallery of every drop-in component from @relipay/react.
 *
 * This server component resolves the data the components need (the user's orgs,
 * the active team's members, the plan catalogue, entitlements, and the app's
 * billingSubject) using the SAME server SDK + Server Actions the rest of the
 * boilerplate uses, then hands them to the <KitchenSink> client component.
 *
 * The point: the drop-in widgets compose with the app's existing server actions
 * — they are not a parallel, browser-side auth path. Every mutation flows
 * through @relipay/node on the server (secret key), never the browser.
 */

import * as React from 'react';
import { redirect } from 'next/navigation';
import { getSession, getAppConfig, getActiveOrgId } from '@/lib/session';
import { relipay, RelipayError } from '@/lib/relipay';
import {
  signInAction,
  signUpAction,
  signOutAction,
  createOrgAction,
  switchOrgAction,
  inviteMemberAction,
  checkoutAction,
} from '@/lib/actions';
import { PLAN_PRO } from '@/lib/constants';
import { KitchenSink } from '@/components/kitchen-sink';
import type {
  OrganizationWithRoleDto,
  OrganizationMemberDto,
  PlanDto,
} from '@relipay/node';

/** Magic-link Server Action used by the <SignIn> widget's magic-link form. */
async function magicLinkAction(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect('/kitchen-sink?error=missing');
  try {
    const base = process.env.APP_BASE_URL ?? 'http://localhost:3040';
    const res = await relipay.auth.requestMagicLink({
      email,
      signInUrl: `${base}/api/auth/magic-link/verify?token={token}`,
    });
    if (res.magicLinkToken) {
      redirect(`/kitchen-sink?magic=${encodeURIComponent(res.magicLinkToken)}`);
    }
  } catch (err) {
    if (err instanceof RelipayError) redirect(`/kitchen-sink?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect('/kitchen-sink?sent=1');
}

export default async function KitchenSinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const magicToken = typeof params.magic === 'string' ? params.magic : undefined;
  const sent = params.sent === '1';
  const error = typeof params.error === 'string' ? params.error : undefined;

  const config = await getAppConfig();
  const session = await getSession();

  // Resolve everything server-side (the widgets receive these as props).
  let organizations: OrganizationWithRoleDto[] = [];
  let members: OrganizationMemberDto[] = [];
  let activeOrgId: string | null = null;
  let activeOrgName: string | null = null;
  let viewerRole: string | undefined;
  let currentPlanSlug: string | null = null;
  let features: Record<string, boolean | number | string> = {};

  const plans: PlanDto[] = await relipay.billing.getPlans().catch(() => []);

  if (session) {
    activeOrgId = await getActiveOrgId(session.accessToken);
    organizations = await relipay.organizations.listMine(session.accessToken).catch(() => []);
    const active = organizations.find((o) => o.id === activeOrgId);
    activeOrgName = active?.name ?? null;
    viewerRole = active?.role;
    if (activeOrgId) {
      members = await relipay.organizations.listMembers(session.accessToken, activeOrgId).catch(() => []);
    }
    const ent = await relipay.billing
      .getEntitlements(session.accessToken, activeOrgId ? { organizationId: activeOrgId } : undefined)
      .catch(() => null);
    if (ent) {
      features = ent.features;
      // Treat the analytics feature flag as the "Pro" signal (mirrors lib/entitlements).
      currentPlanSlug = ent.features.analytics === true ? PLAN_PRO : 'free';
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-relipay-700 dark:text-relipay-500">@relipay/react kitchen sink</h1>
        <p className="text-sm text-neutral-500">
          Every drop-in component, wired to this app&apos;s own Server Actions. App billing subject:{' '}
          <strong>{config.billingSubject}</strong>
          {session ? ` · signed in as ${session.user.email}` : ' · signed out'}.
        </p>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {sent && (
        <div className="rounded-lg border border-relipay-600 bg-relipay-50 dark:bg-relipay-800/30 px-3 py-2 text-sm text-relipay-800 dark:text-relipay-100">
          Magic link sent — check your inbox.
        </div>
      )}
      {magicToken && (
        <div className="rounded-lg border border-relipay-600 bg-relipay-50 dark:bg-relipay-800/30 px-3 py-2 text-sm text-relipay-800 dark:text-relipay-100">
          No email transport configured —{' '}
          <a className="underline" href={`/api/auth/magic-link/verify?token=${encodeURIComponent(magicToken)}`}>
            click here to sign in
          </a>
          .
        </div>
      )}

      <KitchenSink
        signInAction={signInAction}
        signUpAction={signUpAction}
        magicLinkAction={magicLinkAction}
        signOutAction={signOutAction}
        createOrgAction={createOrgAction}
        switchOrgAction={switchOrgAction}
        inviteMemberAction={inviteMemberAction}
        checkoutAction={checkoutAction}
        billingSubject={config.billingSubject}
        activeOrgId={activeOrgId}
        organizations={organizations.map((o) => ({ id: o.id, name: o.name, role: o.role }))}
        members={members.map((m) => ({ id: m.endUserId, email: m.email, role: m.role }))}
        viewerRole={viewerRole}
        activeOrgName={activeOrgName}
        plans={plans.map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          amount: p.amount,
          currency: p.currency,
          interval: p.interval,
          kind: p.kind,
          creditsAmount: p.creditsAmount,
        }))}
        currentPlanSlug={currentPlanSlug}
        features={features}
      />
    </main>
  );
}
