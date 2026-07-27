import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  api,
  PanelApiError,
  type ApplicationRow,
  type MeDto,
  type MemberRow,
  type InvitationRow,
  type PlanRow,
  type ApiKeyRow,
} from '@/lib/api';
import { Modal } from '@/components/Modal';
import { SlugAvailabilityField } from '@/components/SlugAvailabilityField';
import { SubmitButton } from '@/components/SubmitButton';
import { Pager, readPageSize } from '@/components/Pager';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { OnboardingChecklist, type OnboardingStep } from '@/components/OnboardingChecklist';
import { ReadyToGoLive } from '@/components/ReadyToGoLive';
import { Banner } from '@/components/Banner';

async function createApp(formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();
  if (!name || !slug) redirect('/applications?error=missing&newApp=1');
  try {
    const app = await api<ApplicationRow>({
      method: 'POST',
      path: '/api/v1/tenant/applications/',
      body: { name, slug },
    });
    revalidatePath(`/applications/${app.id}`);
    redirect(`/applications/${app.id}?saved=created&e=app_created`);
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications?error=${encodeURIComponent(err.code)}&newApp=1`);
    }
    throw err;
  }
}

const ERR: Record<string, string> = {
  missing: 'Name and slug are required.',
  APPLICATION_SLUG_INVALID: 'Slug must be lowercase letters, digits, and hyphens (max 40 chars).',
  APPLICATION_SLUG_TAKEN: 'That slug is already taken (slugs are globally unique).',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can create applications.',
};

/**
 * Derive the "Get started" checklist from real workspace state — no new API
 * endpoints, everything comes from data this page already has (the app list,
 * which carries authConfig.methods + billingConfig.enabled) or from cheap
 * existing reads (team members/invitations, plans of the first billing-enabled
 * app). Steps whose state can't be determined (a fetch failed, e.g. member-role
 * restrictions) are omitted rather than shown with a guess.
 *
 * `allDone` flips when every derivable step is complete — the caller then
 * swaps the checklist for the dismissible "ready to go live" card (WP10).
 */
async function buildOnboardingSteps(apps: ApplicationRow[]): Promise<{
  steps: OnboardingStep[];
  tenantId: string;
  allDone: boolean;
}> {
  const firstApp = apps[0];
  const [me, members, invitations, firstAppKeys] = await Promise.all([
    api<MeDto>({ method: 'GET', path: '/api/v1/tenant/auth/me' }).catch(() => null),
    api<MemberRow[]>({ method: 'GET', path: '/api/v1/tenant/workspace/members' }).catch(() => null),
    api<InvitationRow[]>({ method: 'GET', path: '/api/v1/tenant/workspace/invitations' }).catch(
      () => null,
    ),
    // API keys of the first app — drives the "mint your first key" step.
    // (One cheap read; omitted-on-failure like the other derived steps.)
    firstApp
      ? api<ApiKeyRow[]>({
          method: 'GET',
          path: `/api/v1/tenant/applications/${encodeURIComponent(firstApp.id)}/api-keys`,
        }).catch(() => null)
      : Promise.resolve([] as ApiKeyRow[]),
  ]);

  const billingApp = apps.find((a) => a.billingConfig.enabled);
  // One extra read, only when an app actually has billing enabled — the list
  // payload doesn't include plans.
  const plans = billingApp
    ? await api<PlanRow[]>({
        method: 'GET',
        path: `/api/v1/tenant/applications/${encodeURIComponent(billingApp.id)}/plans`,
      }).catch(() => null)
    : [];

  const createHref = '/applications?newApp=1'; // reopens the create modal via modalKey
  // Four of the steps below (key, auth, billing, plan) operate on an
  // application, so they can't be acted on until one exists. We *don't* disable
  // them (greying out most of the card reads as broken and gives no affordance)
  // — instead the entry step gets a "Start here" pill and the dependent steps
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
      description: 'Pick how end-users sign in — password, OAuth, passkeys.',
      href: firstApp ? `/applications/${firstApp.id}/auth` : createHref,
      done: apps.some((a) => (a.authConfig.methods ?? []).length > 0),
      hint: requiresAppHint,
    },
    {
      key: 'billing',
      label: 'Enable billing and add a provider',
      description: 'Turn on the billing surface and connect Stripe, PayPal, or Razorpay.',
      href: firstApp ? `/applications/${firstApp.id}/billing` : createHref,
      done: billingApp !== undefined,
      hint: requiresAppHint,
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
            href: '/team',
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

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const PAGE_SIZE = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  const apps = await api<ApplicationRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/?limit=${PAGE_SIZE}&offset=${offset}`,
  });

  // Onboarding state only matters on the first page — paginating past page
  // one means this is not a new workspace, so skip the extra reads entirely.
  const onboarding = offset === 0 ? await buildOnboardingSteps(apps) : null;

  return (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8 lg:px-8">
      <PageHeader
        title="Applications"
        description="Each application has its own end-users, API keys, OAuth providers, and (optionally) billing."
        /* Hide the header trigger on the empty state — the prominent CTA in
           the empty state is the right entry point, and rendering both
           here used to collide on modalKey="newApp" (HIGH #7 fix). */
        action={apps.length > 0 ? <NewAppModal error={error} modalKey="newApp" /> : undefined}
      />

      {onboarding && !onboarding.allDone && (
        <OnboardingChecklist
          steps={onboarding.steps}
          storageKey={`rekey.onboarding.dismissed.${onboarding.tenantId}`}
        />
      )}

      {/* Every onboarding step done — swap the checklist for a dismissible
          "go live" pointer card (WP10). */}
      {onboarding && onboarding.allDone && apps[0] && (
        <ReadyToGoLive
          storageKey={`rekey.ready.dismissed.${onboarding.tenantId}`}
          links={[
            {
              label: 'Quick start',
              description: 'The app overview walks through wiring the SDK into your backend.',
              href: `/applications/${apps[0].id}`,
            },
            {
              label: 'API keys',
              description: 'Make sure production runs on a live key, not a test one.',
              href: `/applications/${apps[0].id}/api-keys`,
            },
            {
              label: 'Billing providers',
              description: 'Switch your provider from test to live mode when you’re ready to charge.',
              href: `/applications/${apps[0].id}/billing`,
            },
          ]}
        />
      )}

      {apps.length === 0 ? (
        <EmptyState
          title="No applications yet"
          description={
            <>
              An application is a self-contained pool of end-users with its own auth configuration,
              OAuth providers, and (optionally) billing. Most teams start with one per environment
              (e.g. <code>acme-prod</code>, <code>acme-staging</code>).
            </>
          }
          action={
            <NewAppModal
              error={error}
              triggerLabel="Create your first application"
              triggerSize="md"
              modalKey="newApp"
            />
          }
        />
      ) : (
        <ul className="space-y-2.5">
          {apps.map((a) => {
            const methodCount = (a.authConfig.methods ?? []).length;
            return (
              <li key={a.id}>
                <Link
                  href={`/applications/${a.id}`}
                  className="group flex items-center justify-between gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 transition-colors hover:border-[color-mix(in_srgb,var(--color-primary)_40%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-surface-muted)_40%,transparent)]"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-[var(--color-fg)]">{a.name}</div>
                    <div className="mt-0.5 truncate font-mono text-xs text-[var(--color-muted-fg)]">{a.slug}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-[var(--color-muted-fg)]">
                    <span>
                      {methodCount} auth method{methodCount === 1 ? '' : 's'}
                    </span>
                    <span
                      aria-hidden="true"
                      className="text-[var(--color-faint-fg)] transition-transform group-hover:translate-x-0.5"
                    >
                      →
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <Pager basePath="/applications" offset={offset} pageSize={PAGE_SIZE} count={apps.length} />
    </section>
  );
}

function NewAppModal({
  error,
  triggerLabel = '+ New application',
  triggerSize = 'sm',
  modalKey,
}: {
  error?: string;
  triggerLabel?: string;
  triggerSize?: 'sm' | 'md';
  modalKey: string;
}): React.JSX.Element {
  const triggerCls =
    triggerSize === 'md'
      ? 'inline-block rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] cursor-pointer'
      : 'inline-block rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] cursor-pointer whitespace-nowrap';
  return (
    <Modal
      modalKey={modalKey}
      title="Create application"
      description="An application is a self-contained set of end-users, auth, and (optional) billing. The slug is baked into API keys and webhook URLs, so it can't be changed later."
      trigger={triggerLabel}
      triggerClassName={triggerCls}
    >
      <form action={createApp} className="space-y-3">
        {error && (
          <Banner tone="error">
            {ERR[error] ?? 'Something went wrong. Please try again.'}
          </Banner>
        )}
        <label className="block space-y-1">
          <span className="text-xs font-medium">Application name</span>
          <input
            type="text"
            name="name"
            required
            autoFocus
            placeholder="Acme Production"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
          />
          <span className="block text-xs text-[var(--color-muted-fg)]">Shown to your team in the panel.</span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">Slug</span>
          <SlugAvailabilityField
            placeholder="acme-prod"
            inputClassName="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
          />
        </label>
        <div className="rounded-md bg-[var(--color-surface-muted)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-fg)] space-y-1">
          <p className="font-medium text-[var(--color-fg)]">What you get</p>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>Email + password sign-up / sign-in</li>
            <li>Empty OAuth slot (add Google / Microsoft / OIDC / … later)</li>
            <li>Mintable API keys</li>
            <li><strong>No billing</strong> — opt in on the Billing tab when you're ready</li>
          </ul>
        </div>
        <SubmitButton pendingLabel="Creating application…">Create application</SubmitButton>
      </form>
    </Modal>
  );
}
