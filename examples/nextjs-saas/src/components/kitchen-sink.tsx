'use client';

/**
 * A live gallery of every drop-in component from @rekey.dev/react.
 *
 * This is a Client Component (the kit uses hooks + local state), but it stays
 * honest about Rekey's security model: every mutating widget is wired to the
 * app's OWN Server Actions (passed down as props from the server page), not to
 * any browser-side API call. The kit reads auth state from <RekeyProvider>
 * (seeded server-side in the root layout) via useUser() under the hood.
 *
 * Server-resolved data (orgs, members, plans, entitlements, the app's
 * billingSubject + active org) is passed in as props — exactly how a real app
 * would feed these components.
 */

import * as React from 'react';
import {
  SignedIn,
  SignedOut,
  Protect,
  RekeyLoading,
  RekeyLoaded,
  SignIn,
  SignUp,
  UserButton,
  SignInButton,
  SignUpButton,
  SignOutButton,
  OrganizationSwitcher,
  CreateOrganization,
  OrganizationProfile,
  PricingTable,
  CheckoutButton,
  type FormAction,
  type Appearance,
  type OrgSummary,
  type OrgMember,
  type PricingPlan,
} from '@rekey.dev/react';

/** Brand the kit to the demo's teal so it visually matches the rest of the app. */
const rekeyTheme: Appearance = {
  variables: {
    colorPrimary: '#0d9488',
    borderRadius: '12px',
  },
};

export interface KitchenSinkProps {
  // ── Server Actions (the app already ships these in src/lib/actions.ts) ──
  signInAction: FormAction;
  signUpAction: FormAction;
  magicLinkAction: FormAction;
  signOutAction: FormAction;
  createOrgAction: FormAction;
  switchOrgAction: FormAction;
  inviteMemberAction: FormAction;
  checkoutAction: FormAction;
  // ── Server-resolved data ──
  billingSubject: 'user' | 'org';
  activeOrgId: string | null;
  organizations: OrgSummary[];
  members: OrgMember[];
  viewerRole: string | undefined;
  activeOrgName: string | null;
  plans: PricingPlan[];
  currentPlanSlug: string | null;
  features: Record<string, boolean | number | string>;
}

function Section({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="card">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-neutral-500 mb-3">{blurb}</p>
      <div className="flex flex-wrap items-start gap-6">{children}</div>
    </section>
  );
}

export function KitchenSink(props: KitchenSinkProps): React.JSX.Element {
  const orgGateBlocking = props.billingSubject === 'org' && !props.activeOrgId;

  return (
    <div className="space-y-5">
      {/* Control components ------------------------------------------------ */}
      <Section
        title="Control components"
        blurb="<SignedIn> / <SignedOut> / <Protect> / <RekeyLoading> / <RekeyLoaded> — render regions by auth state + entitlements."
      >
        <div className="space-y-1 text-sm">
          <RekeyLoading><span className="pill">resolving session…</span></RekeyLoading>
          <RekeyLoaded>
            <SignedIn><span className="pill pill-pro">You are signed in</span></SignedIn>
            <SignedOut><span className="pill">You are signed out</span></SignedOut>
          </RekeyLoaded>
          <div>
            <Protect
              authorization={{ features: props.features, role: props.viewerRole }}
              feature="analytics"
              fallback={<span className="pill">analytics: Pro feature (locked)</span>}
            >
              <span className="pill pill-pro">analytics unlocked</span>
            </Protect>
          </div>
          <div>
            <Protect
              authorization={{ role: props.viewerRole }}
              role={['OWNER', 'ADMIN']}
              fallback={<span className="pill">admin tools: hidden (not an owner/admin)</span>}
            >
              <span className="pill pill-pro">admin tools visible</span>
            </Protect>
          </div>
        </div>
      </Section>

      {/* UserButton + buttons --------------------------------------------- */}
      <Section
        title="UserButton & action buttons"
        blurb="<UserButton> avatar menu (signed in) and the <SignInButton>/<SignUpButton>/<SignOutButton> helpers."
      >
        <SignedIn>
          <UserButton
            appearance={rekeyTheme}
            manageAccountUrl="/account"
            sessionsUrl="/account"
            signOutAction={props.signOutAction}
          />
          <SignOutButton action={props.signOutAction} appearance={rekeyTheme} />
        </SignedIn>
        <SignedOut>
          <SignInButton url="/kitchen-sink#sign-in" appearance={rekeyTheme} />
          <SignUpButton url="/kitchen-sink#sign-up" appearance={rekeyTheme} />
        </SignedOut>
      </Section>

      {/* Auth widgets ----------------------------------------------------- */}
      <Section
        title="Auth widgets"
        blurb="<SignIn> (password + magic link) and <SignUp>. They post to the app's own Server Actions — no credential touches the browser."
      >
        <div id="sign-in">
          <SignIn
            appearance={rekeyTheme}
            action={props.signInAction}
            magicLinkAction={props.magicLinkAction}
            signUpUrl="/signup"
            forgotPasswordUrl="/forgot-password"
            subtitle="Wired to signInAction from src/lib/actions.ts"
          />
        </div>
        <div id="sign-up">
          <SignUp
            appearance={rekeyTheme}
            action={props.signUpAction}
            signInUrl="/login"
            subtitle="Wired to signUpAction"
          />
        </div>
      </Section>

      {/* Org widgets ------------------------------------------------------ */}
      <Section
        title="Organization widgets"
        blurb={`<OrganizationSwitcher> / <CreateOrganization> / <OrganizationProfile> — respecting billingSubject='${props.billingSubject}'.`}
      >
        <SignedIn>
          <OrganizationSwitcher
            appearance={rekeyTheme}
            organizations={props.organizations}
            activeOrganizationId={props.activeOrgId}
            switchAction={props.switchOrgAction}
            createAction={props.createOrgAction}
            billingSubject={props.billingSubject}
          />
          <CreateOrganization appearance={rekeyTheme} action={props.createOrgAction} />
          {props.activeOrgId && (
            <OrganizationProfile
              appearance={rekeyTheme}
              organization={{ id: props.activeOrgId, name: props.activeOrgName ?? 'Active team' }}
              members={props.members}
              viewerRole={props.viewerRole}
              inviteAction={props.inviteMemberAction}
              hiddenFields={{ orgId: props.activeOrgId }}
            />
          )}
        </SignedIn>
        <SignedOut>
          <p className="text-sm text-neutral-500">Sign in to see the organization widgets.</p>
        </SignedOut>
      </Section>

      {/* Billing widgets -------------------------------------------------- */}
      <Section
        title="Billing widgets"
        blurb="<PricingTable> renders plans from billing.getPlans() with upgrade buttons; <CheckoutButton> is a single-plan CTA. Org-scoped when a team is active."
      >
        <div className="w-full space-y-4">
          <PricingTable
            appearance={rekeyTheme}
            plans={props.plans}
            currentPlanSlug={props.currentPlanSlug}
            checkoutAction={props.checkoutAction}
            orgGateBlocking={orgGateBlocking}
            {...(props.activeOrgId ? { hiddenFields: { orgId: props.activeOrgId } } : {})}
          />
          {!orgGateBlocking && props.plans.some((p) => p.amount > 0) && (
            <SignedIn>
              <CheckoutButton
                appearance={rekeyTheme}
                planSlug={props.plans.find((p) => p.amount > 0)!.slug}
                action={props.checkoutAction}
                {...(props.activeOrgId ? { hiddenFields: { orgId: props.activeOrgId } } : {})}
              >
                Upgrade with a single CheckoutButton
              </CheckoutButton>
            </SignedIn>
          )}
        </div>
      </Section>
    </div>
  );
}
