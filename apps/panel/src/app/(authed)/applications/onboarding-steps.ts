import { api, getMe, type ApiKeyRow, type ApplicationRow, type BillingCredentialRow, type InvitationRow, type MemberRow, type PlanRow } from '@/lib/api';
import { emptyPage, type Page } from '@/lib/paginate';
import type { OnboardingStep } from '@/components/OnboardingChecklist';
import { authConfigVisible, signInReachable } from '@/lib/auth-config';

/**
 * Derive the "Get started" checklist from real workspace state, no new API
 * endpoints, everything comes from data this page already has (the app list,
 * which carries authConfig.methods + billingConfig.enabled) or from cheap
 * existing reads (team members/invitations, plans of the first billing-enabled
 * app). Steps whose state can't be determined (a fetch failed, e.g. member-role
 * restrictions) are omitted rather than shown with a guess.
 *
 * `allDone` flips when every derivable step is complete, the caller then
 * swaps the checklist for the dismissible "ready to go live" card (WP10).
 */
/** How many applications the key step looks at; each is one small read. */
const KEY_CHECK_APPS = 3;

export async function buildOnboardingSteps(apps: ApplicationRow[]): Promise<{
  steps: OnboardingStep[];
  tenantId: string;
  allDone: boolean;
}> {
  const firstApp = apps[0];
  const [me, memberPage, invitationPage, keyLists] = await Promise.all([
    getMe().catch(() => null),
    api<Page<MemberRow>>({ method: 'GET', path: '/api/v1/tenant/workspace/members' }).catch(
      () => null,
    ),
    api<Page<InvitationRow>>({
      method: 'GET',
      path: '/api/v1/tenant/workspace/invitations',
    }).catch(() => null),
    // API keys of the newest few apps, for the "mint your first key" step. The
    // list is newest first, so checking only the first app left the step
    // unticked as soon as a second app was created after the key was minted.
    Promise.all(
      apps.slice(0, KEY_CHECK_APPS).map((a) =>
        api<ApiKeyRow[]>({
          method: 'GET',
          path: `/api/v1/tenant/applications/${encodeURIComponent(a.id)}/api-keys`,
          interruptOnAccessError: false,
        }).catch(() => null),
      ),
    ),
  ]);
  // Null only when every read failed: then the step is omitted, not shown undone.
  const readable = keyLists.filter((k): k is ApiKeyRow[] => k !== null);
  const firstAppKeys = keyLists.length > 0 && readable.length === 0 ? null : readable.flat();
  // null is load-bearing below: "the read failed, omit the step" is a different
  // answer from "the list is empty, the step is not done".
  const members = memberPage === null ? null : memberPage.items;
  const invitations = invitationPage === null ? null : invitationPage.items;

  const billingApp = apps.find((a) => a.billingConfig.enabled);
  // Two extra reads, only when an app actually has billing enabled, the list
  // payload carries neither plans nor provider credentials.
  //
  // The credentials read is what makes the billing step honest. `billingConfig
  // .enabled` alone ticked "Enable billing and add a provider" for an
  // application with ZERO providers configured, which is a checkout that fails
  // with BILLING_CREDENTIALS_NOT_CONFIGURED, the checklist was reporting
  // production-ready on a state that cannot take a payment. The step says "and
  // add a provider", so it needs both halves.
  const [planPage, billingCredentials] = billingApp
    ? await Promise.all([
        api<Page<PlanRow>>({
          method: 'GET',
          path: `/api/v1/tenant/applications/${encodeURIComponent(billingApp.id)}/plans`,
        }).catch(() => null),
        // Not paginated, one row per configured provider, still a bare array.
        api<BillingCredentialRow[]>({
          method: 'GET',
          path: `/api/v1/tenant/applications/${encodeURIComponent(billingApp.id)}/billing-credentials`,
        }).catch(() => null),
      ])
    : [emptyPage<PlanRow>(), [] as BillingCredentialRow[]];
  const plans = planPage === null ? null : planPage.items;
  // The endpoint returns one row per CONFIGURED provider, so a non-empty list
  // is the signal. Null means the read failed, fall back to the old
  // enabled-only answer rather than claiming the step is incomplete.
  const providerConfigured =
    billingCredentials === null ? true : billingCredentials.length > 0;

  const createHref = '/applications?newApp=1'; // reopens the create modal via modalKey
  // Four of the steps below (key, auth, billing, plan) operate on an
  // application, so they can't be acted on until one exists. We *don't* disable
  // them (greying out most of the card reads as broken and gives no affordance)
  //, instead the entry step gets a "Start here" pill and the dependent steps
  // get a muted "Requires an application" hint. Their hrefs already fall back to
  // the create-app modal, so an early click guides the user forward rather than
  // dead-ending. The hint/pill clear themselves once an app exists.
  const noApp = apps.length === 0;
  const requiresAppHint = noApp ? 'Requires an application' : undefined;
  const steps: OnboardingStep[] = [
    {
      key: 'create-app',
      label: 'Create your first application',
      description: 'An isolated pool of end-users with its own auth, API keys, and billing.',
      href: createHref,
      done: apps.length > 0,
      pill: noApp ? 'Start here' : undefined,
    },
    ...(firstAppKeys !== null
      ? [
          {
            key: 'api-key',
            label: 'Mint your first API key',
            description: 'The server-side credential your backend uses to call Rekey.',
            href: firstApp ? `/applications/${firstApp.id}/api-keys` : createHref,
            done: (firstAppKeys ?? []).some((k) => k.revokedAt === null),
            hint: requiresAppHint,
          },
        ]
      : []),
    {
      key: 'auth-method',
      label: 'Configure an auth method',
      description: 'Pick how end-users sign in, password, OAuth, passkeys.',
      href: firstApp ? `/applications/${firstApp.id}/auth` : createHref,
      // `signInReachable`, not a methods count: an OAuth-only application has
      // no primary method and is fully configured. Counting methods called it
      // unconfigured while the row's badges called it healthy, on one screen.
      done: apps.some((a) => authConfigVisible(a) && signInReachable(a)),
      hint: requiresAppHint,
    },
    {
      key: 'billing',
      label: 'Enable billing and add a provider',
      description: 'Turn on the billing surface and connect Stripe, PayPal, or Razorpay.',
      href: billingApp
        ? `/applications/${billingApp.id}/billing`
        : firstApp
          ? `/applications/${firstApp.id}/billing`
          : createHref,
      done: billingApp !== undefined && providerConfigured,
      hint:
        requiresAppHint ??
        (billingApp !== undefined && !providerConfigured
          ? 'Billing is on, but no provider is configured, so checkout would fail'
          : undefined),
    },
    ...(plans !== null
      ? [
          {
            key: 'plan',
            label: 'Create a plan',
            description: 'Subscription, license, usage, or credit pricing your end-users can buy.',
            href: billingApp
              ? `/applications/${billingApp.id}/plans`
              : firstApp
                ? `/applications/${firstApp.id}/billing`
                : createHref,
            done: (plans ?? []).length > 0,
            hint: requiresAppHint,
          },
        ]
      : []),
    ...(members !== null || invitations !== null
      ? [
          {
            key: 'invite',
            label: 'Invite a teammate',
            description: 'Bring a colleague into this workspace.',
            href: '/team/invitations',
            done:
              (members?.length ?? 0) > 1 ||
              (invitations ?? []).some((i) => i.status === 'pending'),
          },
        ]
      : []),
  ];

  return {
    steps,
    tenantId: me?.activeTenantId ?? 'unknown',
    allDone: steps.every((s) => s.done),
  };
}
