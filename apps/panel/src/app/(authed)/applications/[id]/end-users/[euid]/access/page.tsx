/**
 * End-user Access: ban the whole account, see who banned it and why, lift it.
 *
 * A device block stops one machine; a ban stops the person. It ends every
 * session and grant now and refuses every sign-in until an operator lifts it.
 * It does not touch billing, which is why the ban dialog counts the live
 * subscriptions: a banned customer who keeps paying is the trap here.
 *
 * The reason is operator-only free text and is rendered as a plain React text
 * child, never as markup or a link.
 */

import * as React from 'react';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { Card, SectionHeader } from '@/components/Card';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { Field } from '@/components/Field';
import { ActionForm } from '@/components/ActionForm';
import Link from '@/components/Link';
import { Modal } from '@/components/Modal';
import { SubmitButton } from '@/components/SubmitButton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { formatDateTime } from '@/lib/date';
import { errorMessage } from '@/lib/error-message';
import { getApplication } from '@/lib/api';
import { hasScope } from '@/lib/operator-scopes';
import { banEndUser, unbanEndUser } from '../actions';
import { getEndUserBan, getEndUserBilling, getEndUserDetail } from '../shared';

const BAN_ERR: Record<string, string> = {
  BAN_REASON_INVALID: 'Write a reason of up to 500 characters. Your team reads it later; the end-user never does.',
  END_USER_ERASED: 'This end-user was erased. There is no account left to ban.',
  END_USER_NOT_FOUND: 'That end-user no longer exists in this Application.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
  TENANT_ROLE_INSUFFICIENT: 'Your role cannot ban end-users on this Application.',
};

const LIVE_SUBSCRIPTION = new Set(['ACTIVE', 'TRIALING', 'PAST_DUE']);

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function resultMessage(done: string, revoked: number): string | null {
  switch (done) {
    case 'done':
      return `Banned. ${revoked === 0 ? 'They had no open sessions.' : `${plural(revoked, 'session', 'sessions')} ended.`}`;
    case 'already':
      return 'They were already banned. The original ban, its reason and who placed it are unchanged.';
    case 'lifted':
      return 'Ban lifted. They can sign in again with their usual method.';
    default:
      return null;
  }
}

export default async function EndUserAccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;
  const done = typeof sp.ban === 'string' ? resultMessage(sp.ban, Number(sp.revoked) || 0) : null;
  const banError = typeof sp.banError === 'string' ? sp.banError : undefined;

  const [detail, application, ban] = await Promise.all([
    getEndUserDetail(id, euid),
    getApplication(id),
    getEndUserBan(id, euid),
  ]);
  const scopes = application.access?.scopes ?? null;
  const canBilling = hasScope(scopes, 'billing:read');
  const canWrite = hasScope(scopes, 'end-users:write');
  const billing = canBilling ? await getEndUserBilling(id, euid) : null;
  const liveSubscriptions = billing?.subscriptions.filter((s) => LIVE_SUBSCRIPTION.has(s.status)).length ?? 0;
  const isErased = detail.endUser.erasedAt !== null;
  const base = `/applications/${id}/end-users/${euid}`;

  if (ban === null) {
    return (
      <div className="space-y-4">
        <SectionHeader title="Access" />
        <Banner tone="error">
          The ban state could not be read. Either the request failed, or your access to this
          Application does not cover it. This does <strong>not</strong> mean the end-user is
          unbanned. Reload; if it persists, check the API and your access.
        </Banner>
      </div>
    );
  }

  const { state, history } = ban;
  const bannedBy = state.bannedByEmail ?? (state.bannedBy ? 'a former member' : 'unknown');
  const billingNote =
    liveSubscriptions > 0 ? (
      <>
        Their {plural(liveSubscriptions, 'subscription', 'subscriptions')} keep billing. Cancel them
        on the <Link href={`${base}/subscriptions`}>Subscriptions tab</Link> if they should stop paying.
      </>
    ) : billing !== null ? (
      'They have no live subscriptions.'
    ) : (
      // No billing scope, or the read failed: say what a ban does rather than
      // claim there is nothing to cancel.
      'Subscriptions keep billing; a ban does not cancel them.'
    );

  return (
    <div className="space-y-6">
      {done && <Banner tone="success">{done}</Banner>}
      {banError && <Banner tone="error">{errorMessage(BAN_ERR, banError)}</Banner>}

      <section className="space-y-3">
        <SectionHeader
          title="Access"
          description="Ban this end-user to sign them out everywhere and refuse every sign-in until you lift it. To stop one machine instead, block it on the Devices tab."
        />
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">Status</h3>
            {state.banned ? (
              <Badge tone="danger" dot>
                banned
              </Badge>
            ) : (
              <Badge tone="success" dot>
                can sign in
              </Badge>
            )}
          </div>

          {state.banned ? (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
              <dt className="text-[var(--color-muted-fg)]">Banned</dt>
              <dd>{state.bannedAt ? formatDateTime(state.bannedAt) : 'unknown'}</dd>
              <dt className="text-[var(--color-muted-fg)]">By</dt>
              <dd>{bannedBy}</dd>
              <dt className="text-[var(--color-muted-fg)]">Reason</dt>
              <dd className="whitespace-pre-wrap break-words">
                {state.banReason ?? <span className="text-[var(--color-muted-fg)]">removed when the account was erased</span>}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-[var(--color-muted-fg)]">
              Nothing is stopping this end-user from signing in.
            </p>
          )}

          {!isErased && canWrite && (
            <div className="flex items-center gap-4 pt-1">
              {state.banned ? (
                <ActionForm action={unbanEndUser.bind(null, id, euid)} className="inline">
                  <ConfirmButton
                    variant="subtle"
                    title="Lift the ban?"
                    confirm="They can sign in again with their existing password or sign-in method. Sessions ended by the ban stay ended."
                    confirmLabel="Lift ban"
                  >
                    Lift ban
                  </ConfirmButton>
                </ActionForm>
              ) : (
                <Modal
                  title="Ban this end-user?"
                  description="They are signed out everywhere now, and every sign-in is refused until you lift the ban. Licence keys they hold stop verifying, apart from organization licences. Your reason stays with your team and is never shown to them."
                  trigger="Ban end-user"
                  triggerClassName="text-xs text-red-600 dark:text-red-400 hover:underline"
                >
                  <ActionForm action={banEndUser.bind(null, id, euid)} className="space-y-3">
                    <p className="text-sm text-[var(--color-fg)]">{billingNote}</p>
                    <Field label="Reason" hint="Required, up to 500 characters. Shown in the audit history.">
                      <textarea
                        name="reason"
                        required
                        maxLength={500}
                        rows={3}
                        placeholder="Chargeback fraud, ticket 4412"
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]"
                      />
                    </Field>
                    <SubmitButton pendingLabel="Banning…">Ban end-user</SubmitButton>
                  </ActionForm>
                </Modal>
              )}
            </div>
          )}
          {state.banned && !isErased && <p className="text-xs text-[var(--color-muted-fg)]">{billingNote}</p>}
        </Card>
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Ban history"
          count={`(${history.length})`}
          description="Every ban and lift on this account, newest first, with the operator who did it."
        />
        {history.length === 0 ? (
          <EmptyState variant="inline" title="Never banned" />
        ) : (
          <Table minWidth="min-w-[40rem]">
            <THead>
              <TR>
                <TH>Action</TH>
                <TH>By</TH>
                <TH>Reason</TH>
                <TH>When</TH>
              </TR>
            </THead>
            <TBody>
              {history.map((h) => (
                <TR key={h.id}>
                  <TD>
                    <Badge tone={h.type === 'end_user.banned' ? 'danger' : 'neutral'}>
                      {h.type === 'end_user.banned' ? 'banned' : 'lifted'}
                    </Badge>
                  </TD>
                  <TD className="text-sm">{h.actorEmail ?? (h.actorId ? 'a former member' : 'unknown')}</TD>
                  <TD className="max-w-[24rem] whitespace-pre-wrap break-words text-sm">
                    {h.reason ?? <span className="text-[var(--color-muted-fg)]">none</span>}
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(h.createdAt)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
