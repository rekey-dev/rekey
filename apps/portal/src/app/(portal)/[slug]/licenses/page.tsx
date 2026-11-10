import * as React from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getPortalConfig } from '@/lib/config';
import { getPortalUser, portalClientFor } from '@/lib/session';
import { redirectWhileTwoFactorOutstanding } from '@/lib/two-factor';
import { checkoutLocale } from '@/lib/checkout-format';
import { PORTAL_TIME_ZONE, formatDate } from '@/lib/format';
import { licenses } from '@/lib/account-usage';
import { LICENSE_KEY_SHOWN_ONCE, licenseKindWord, licenseStatusWord } from '@/lib/account-usage-copy';
import { activeMachines } from '@/lib/license-machines';
import { MACHINE_REMOVED, licenseMachineErrorCopy, machineName, seatsLine } from '@/lib/license-machines-copy';
import { removeLicenseMachineAction } from '@/lib/license-actions';
import { listOrganizations, managesMembers } from '@/lib/organizations';
import { Banner } from '@/components/banner';
import { Card } from '@/components/card';
import { ConfirmSubmit } from '@/components/confirm-submit';

export const dynamic = 'force-dynamic';

const mutedCls = 'text-sm text-[var(--color-muted-fg)]';

async function planNames(slug: string, accessToken: string): Promise<Map<string, string>> {
  const client = await portalClientFor(slug);
  if (!client) return new Map();
  const plans = await client
    .getPlans({ limit: 100 }, { accessToken })
    .then((r) => r.items)
    .catch(() => []);
  return new Map(plans.map((p) => [p.id, p.name]));
}

export default async function LicensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const session = await getPortalUser(slug);
  if (!session) redirect(`/${slug}/login`);
  await redirectWhileTwoFactorOutstanding(slug, session.accessToken);
  const config = await getPortalConfig(slug);
  if (!config) notFound();

  const appName = config.branding.displayName || config.name;
  const locale = checkoutLocale((await headers()).get('accept-language'));
  const dateOf = (value: string): string => formatDate(value, locale, PORTAL_TIME_ZONE);
  const [items, names] = await Promise.all([
    licenses(config, session.accessToken),
    planNames(slug, session.accessToken),
  ]);
  const live = (items ?? []).filter((l) => l.status === 'ACTIVE');
  const [machines, organizations] = await Promise.all([
    Promise.all(live.map(async (l) => [l.id, await activeMachines(config, session.accessToken, l.id)] as const)).then(
      (pairs) => new Map(pairs),
    ),
    live.some((l) => l.organizationId !== null) ? listOrganizations(config, session.accessToken) : Promise.resolve(null),
  ]);
  const managedOrgs = new Set((organizations ?? []).filter((o) => managesMembers(o.baseRole)).map((o) => o.id));
  const removed = sp.done === MACHINE_REMOVED;
  const error = typeof sp.error === 'string' ? sp.error : undefined;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Your licenses</h1>
      {removed && <Banner tone="success">The machine was removed, and its seat is free for another.</Banner>}
      {error && <Banner tone="error">{licenseMachineErrorCopy(error)}</Banner>}
      <Card>
        {items === null ? (
          <p className={mutedCls}>Your licenses could not be loaded right now. Reload the page to try again.</p>
        ) : items.length === 0 ? (
          <p className={mutedCls}>
            License keys you buy for {appName} appear here, with their status and when they expire.
          </p>
        ) : (
          <div className="space-y-4">
            <p className={mutedCls}>{LICENSE_KEY_SHOWN_ONCE}</p>
            <ul className="divide-y divide-[var(--color-border)]">
              {items.map((license) => {
                const plan = license.planId ? names.get(license.planId) : undefined;
                const details = [
                  licenseKindWord(license.kind),
                  license.seatsAllowed !== null ? `${license.seatsAllowed} ${license.seatsAllowed === 1 ? 'seat' : 'seats'}` : null,
                  license.expiresAt ? `${license.status === 'EXPIRED' ? 'Expired' : 'Expires'} ${dateOf(license.expiresAt)}` : null,
                  `Issued ${dateOf(license.createdAt)}`,
                ].filter(Boolean);
                return (
                  <li key={license.id} className="space-y-1 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-mono text-[var(--color-fg)]">
                        {license.keyPrefix}
                        <span aria-hidden>…</span>
                        <span className="sr-only"> (only the start of the key is shown)</span>
                      </span>
                      <span className="text-[var(--color-fg)]">{licenseStatusWord(license.status)}</span>
                    </div>
                    {plan && <p className="text-[var(--color-fg)]">{plan}</p>}
                    <p className="text-xs text-[var(--color-muted-fg)]">{details.join(' · ')}</p>
                    <LicenseMachines
                      slug={slug}
                      licenseId={license.id}
                      keyPrefix={license.keyPrefix}
                      appName={appName}
                      seatsAllowed={license.seatsAllowed}
                      machines={machines.get(license.id)}
                      canRemove={license.organizationId === null || managedOrgs.has(license.organizationId)}
                      dateOf={dateOf}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}

function LicenseMachines({
  slug,
  licenseId,
  keyPrefix,
  appName,
  seatsAllowed,
  machines,
  canRemove,
  dateOf,
}: {
  slug: string;
  licenseId: string;
  keyPrefix: string;
  appName: string;
  seatsAllowed: number | null;
  /** Undefined for a licence that is not active; null when they could not be read. */
  machines: Awaited<ReturnType<typeof activeMachines>> | undefined;
  canRemove: boolean;
  dateOf: (value: string) => string;
}): React.JSX.Element | null {
  if (machines === undefined) return null;
  if (machines === null) return <p className="text-xs text-[var(--color-muted-fg)]">Its machines could not be loaded right now.</p>;
  return (
    <div className="space-y-1 pt-2">
      <p className="text-xs text-[var(--color-fg)]">{seatsLine(machines.length, seatsAllowed)}</p>
      {machines.length > 0 && (
        <ul className="divide-y divide-[var(--color-border)]">
          {machines.map((machine) => {
            const name = machineName(machine);
            return (
              <li key={machine.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 text-xs text-[var(--color-fg)]">
                  {name}
                  <span className="block text-[var(--color-muted-fg)]">
                    First used {dateOf(machine.firstSeenAt)} · Last used {dateOf(machine.lastSeenAt)}
                  </span>
                </span>
                {canRemove && (
                  <form action={removeLicenseMachineAction.bind(null, slug, licenseId, machine.id)} className="shrink-0">
                    <ConfirmSubmit
                      variant="danger"
                      size="sm"
                      label="Remove"
                      triggerName={`Remove ${name} from ${keyPrefix}`}
                      title={`Remove ${name}?`}
                      message={`${name} gives back its seat. ${appName} on it stops working with this license until it is activated again, which takes a free seat.`}
                      confirmLabel="Remove machine"
                      cancelLabel="Cancel"
                      pendingLabel="Removing…"
                    />
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
