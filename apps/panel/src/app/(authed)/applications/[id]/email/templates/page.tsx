/**
 * Email templates, and whether each event is sent at all.
 *
 * The two questions belong together, "what does this email say" and "does it
 * go out" are the same row, but they are deliberately independent underneath:
 * `EmailEventSetting` is its own table, so switching an event off does not
 * require customising its body first, and deleting a customisation does not
 * quietly re-enable something somebody turned off.
 *
 * Three of the nine events cannot be switched off while the auth config still
 * depends on them. The API refuses that outright; this page renders the reason
 * in place of the control rather than offering a switch that answers 409.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { errorMessage } from '@/lib/error-message';
import { api, apiGet, PanelApiError } from '@/lib/api';
import { SectionHeader } from '@/components/Card';
import { Table, TBody, TR, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';

interface EventRow {
  key: string;
  label: string;
  enabled: boolean;
  customised: boolean;
  essentialBlocker: { code: string; message: string; fix: string } | null;
  /** Sent by Rekey itself, not by this Application, no switch reaches it. */
  systemScoped?: boolean;
}

interface SendControl {
  emailsEnabled: boolean;
  events: EventRow[];
}

async function setEventEnabled(
  applicationId: string,
  eventKey: string,
  enabled: boolean,
): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/email/templates`;
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-send-control/${encodeURIComponent(eventKey)}`,
      body: { enabled },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?eventError=${encodeURIComponent(err.code)}&event=${encodeURIComponent(eventKey)}`);
    }
    throw err;
  }
  redirect(`${base}?event=${encodeURIComponent(eventKey)}&now=${enabled ? 'on' : 'off'}`);
}

const EVENT_ERR: Record<string, string> = {
  EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG:
    'That email is load-bearing for a sign-in method that is currently switched on. Turn the method off first.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
  TENANT_ROLE_INSUFFICIENT: 'Your role cannot change email settings on this Application.',
};

export default async function EmailTemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const eventError = typeof sp.eventError === 'string' ? sp.eventError : undefined;
  const changed = typeof sp.event === 'string' ? sp.event : undefined;
  const now = typeof sp.now === 'string' ? sp.now : undefined;

  const control = await apiGet<SendControl>(
    `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-send-control`,
    { interruptOnAccessError: false },
  ).catch(() => null);

  if (control === null) {
    return (
      <Banner tone="error">
        The email settings could not be read. Either the request failed, or your access to this
        Application does not cover it.
      </Banner>
    );
  }

  const offCount = control.events.filter((e) => !e.enabled).length;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Templates"
        description="What each email says, and whether it is sent. Where the buttons in these emails point is the application URL on the Authentication tab. With no URL resolvable, the button is left out rather than sent broken."
      />

      {changed && now && (
        <Banner tone="success">
          <code className="font-mono">{changed}</code> is now {now === 'on' ? 'enabled' : 'disabled'}
          {now === 'off' ? '. Attempted sends are still recorded, on the Delivery tab.' : '.'}
        </Banner>
      )}
      {eventError && <Banner tone="error">{errorMessage(EVENT_ERR, eventError)}</Banner>}

      {!control.emailsEnabled && (
        <Banner tone="warning">
          All email is switched off for this Application, so none of these are sent whatever their
          individual state says.{' '}
          <Link href={`/applications/${id}/email`} className="underline underline-offset-2">
            Settings
          </Link>
        </Banner>
      )}
      {control.emailsEnabled && offCount > 0 && (
        <Banner tone="info">
          {offCount} of {control.events.length} events {offCount === 1 ? 'is' : 'are'} switched off.
          Attempted sends are recorded on the Delivery tab rather than vanishing.
        </Banner>
      )}

      <Table>
        <TBody>
          {control.events.map((e) => (
            <TR key={e.key} hover>
              <TD>
                <div className="font-medium">{e.label}</div>
                <div className="font-mono text-xs text-[var(--color-muted-fg)]">{e.key}</div>
                {e.essentialBlocker && (
                  <div className="mt-1 max-w-lg text-[11px] text-[var(--color-muted-fg)]">
                    {e.essentialBlocker.message} {e.essentialBlocker.fix}
                  </div>
                )}
                {e.systemScoped && (
                  <div className="mt-1 max-w-lg text-[11px] text-[var(--color-muted-fg)]">
                    Sent by Rekey to your workspace, not by this Application to its end-users, so
                    this Application&apos;s email switches do not apply to it.
                  </div>
                )}
              </TD>
              <TD>
                {e.systemScoped ? (
                  <Badge tone="neutral">workspace</Badge>
                ) : e.enabled ? (
                  <Badge tone="success" dot>
                    sending
                  </Badge>
                ) : (
                  <Badge tone="danger" dot>
                    off
                  </Badge>
                )}
              </TD>
              <TD>
                <Badge tone={e.customised ? 'info' : 'neutral'}>
                  {e.customised ? 'customised' : 'default'}
                </Badge>
              </TD>
              <TD align="right">
                <div className="flex items-center justify-end gap-3">
                  {e.systemScoped ? (
                    // No switch, because there is nothing for it to switch.
                    // These go out through `dispatchSystem`, which has no
                    // per-Application gate, rendering a control here would
                    // let an operator turn something "off" that keeps arriving.
                    <span
                      className="text-xs text-[var(--color-muted-fg)]"
                      title="Sent by Rekey to your workspace; this Application's email switches do not reach it."
                    >
                      not switchable
                    </span>
                  ) : e.essentialBlocker && e.enabled ? (
                    // No switch at all rather than one that 409s. The reason is
                    // already spelled out beside the event.
                    <span
                      className="text-xs text-[var(--color-muted-fg)]"
                      title={e.essentialBlocker.message}
                    >
                      required
                    </span>
                  ) : (
                    <ActionForm action={setEventEnabled.bind(null, id, e.key, !e.enabled)}>
                      <SubmitButton
                        className="text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline"
                        pendingLabel="Saving…"
                      >
                        {e.enabled ? 'Turn off' : 'Turn on'}
                      </SubmitButton>
                    </ActionForm>
                  )}
                  <Link
                    href={`/applications/${id}/email/${encodeURIComponent(e.key)}`}
                    className="text-sm font-medium text-[var(--color-primary)] hover:underline"
                  >
                    Edit →
                  </Link>
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
