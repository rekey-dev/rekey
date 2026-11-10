import * as React from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getPortalConfig, supportLink } from '@/lib/config';
import { getPortalUser, portalClientFor } from '@/lib/session';
import { redirectWhileTwoFactorOutstanding } from '@/lib/two-factor';
import { redirectWhileProfileOutstanding } from '@/lib/profile-completion';
import { checkoutLocale } from '@/lib/checkout-format';
import { PORTAL_TIME_ZONE, formatDate } from '@/lib/format';
import {
  SELF_RELEASE_DISABLED,
  deviceLimit,
  deviceName,
  devicesSignInPath,
  listDevices,
  removeDeviceErrorCopy,
} from '@/lib/devices';
import { removeDeviceAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { Card } from '@/components/card';
import { ConfirmSubmit } from '@/components/confirm-submit';

export const dynamic = 'force-dynamic';

const mutedCls = 'text-sm text-[var(--color-muted-fg)]';
const linkCls = 'underline hover:text-[var(--color-fg)]';

function devicesWord(n: number): string {
  return n === 1 ? '1 device' : `${n} devices`;
}

function limitLine(appName: string, inUse: number, limit: number): string {
  if (inUse < limit) return `${inUse} of ${devicesWord(limit)} in use.`;
  const taken = limit === 1 ? 'and it is in use' : 'and every one is in use';
  return (
    `Your plan lets you use ${appName} on ${devicesWord(limit)}, ${taken}. To use ${appName} on a new computer, ` +
    'remove one you no longer use, then sign in on the new one.'
  );
}

async function plansOnOffer(slug: string, accessToken: string): Promise<boolean> {
  const client = await portalClientFor(slug);
  if (!client) return false;
  return client
    .getPlans({ limit: 1 }, { accessToken })
    .then((r) => r.items.length > 0)
    .catch(() => false);
}

export default async function DevicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const session = await getPortalUser(slug);
  if (!session) redirect(devicesSignInPath(slug));
  await redirectWhileTwoFactorOutstanding(slug, session.accessToken);
  await redirectWhileProfileOutstanding(slug, session.user, 'devices');
  const config = await getPortalConfig(slug);
  if (!config) notFound();

  const appName = config.branding.displayName || config.name;
  const support = supportLink(config.branding);
  const locale = checkoutLocale((await headers()).get('accept-language'));
  const removedId = typeof sp.removed === 'string' ? sp.removed : undefined;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const selfReleaseOff = error === SELF_RELEASE_DISABLED;

  const [devices, limit, released] = await Promise.all([
    listDevices(config, session.accessToken, 'ACTIVE'),
    deviceLimit(config, session.accessToken),
    removedId ? listDevices(config, session.accessToken, 'RELEASED') : Promise.resolve(null),
  ]);
  const removed = released?.find((d) => d.id === removedId);
  const atLimit = devices !== null && limit !== null && limit > 0 && devices.length >= limit;
  const morePlans = atLimit && config.billingEnabled && (await plansOnOffer(slug, session.accessToken));

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Your devices</h1>
      {removed && (
        <Banner tone="success">
          {deviceName(removed)} was removed. You can now sign in to {appName} on your new device.
        </Banner>
      )}
      {error && !selfReleaseOff && <Banner tone="error">{removeDeviceErrorCopy(error, appName)}</Banner>}
      {selfReleaseOff && (
        <Banner tone="info">
          To remove a device, contact{' '}
          {support ? (
            <a href={support} className="underline">
              {appName} support
            </a>
          ) : (
            `${appName} support`
          )}{' '}
          and tell them which one.
        </Banner>
      )}

      <Card>
        {devices === null ? (
          <p className={mutedCls}>Your devices could not be loaded right now. Reload the page to try again.</p>
        ) : devices.length === 0 ? (
          <p className={mutedCls}>
            No devices are using {appName} right now. Devices appear here after you sign in to the app on them.
          </p>
        ) : (
          <div className="space-y-4">
            {limit !== null && limit > 0 && <p className="text-sm text-[var(--color-fg)]">{limitLine(appName, devices.length, limit)}</p>}
            {morePlans && (
              <p className={mutedCls}>
                Need more devices?{' '}
                <a href={`/${slug}#plans`} className={linkCls}>
                  See plans
                </a>
                .
              </p>
            )}
            <ul className="divide-y divide-[var(--color-border)]">
              {devices.map((device) => {
                const name = deviceName(device);
                return (
                  <li key={device.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="min-w-0 text-sm text-[var(--color-fg)]">
                      {name} · Last used {formatDate(device.lastSeenAt, locale, PORTAL_TIME_ZONE)}
                    </span>
                    {!selfReleaseOff && (
                      <form action={removeDeviceAction.bind(null, slug, device.id)} className="shrink-0">
                        <ConfirmSubmit
                          variant="danger"
                          label="Remove"
                          triggerName={`Remove ${name}`}
                          title={`Remove ${name}?`}
                          message={`${name} will be signed out of ${appName} and will stop counting toward your limit. You can sign in on it again later if you have a free spot.`}
                          confirmLabel="Remove device"
                          cancelLabel="Cancel"
                          pendingLabel="Removing…"
                        />
                      </form>
                    )}
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
