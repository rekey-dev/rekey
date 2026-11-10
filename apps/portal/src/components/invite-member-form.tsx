'use client';

/**
 * Invite someone by email. The API emails them the link; it also comes back
 * in the action's response, offered here once to copy, and lives only in this
 * component's state.
 */

import * as React from 'react';
import { revokeInvitationAction, type InviteState } from '@/lib/organization-actions';
import { roleLabel } from '@/lib/organization-copy';
import { Banner } from './banner';
import { Button } from './button';
import { ConfirmSubmit } from './confirm-submit';
import { SubmitButton } from './submit-button';

const inputCls =
  'w-full min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)]';

function CopyLinkButton({ link, email }: { link: string; email: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(link)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <Button type="button" variant="secondary" className="text-xs" onClick={copy}>
      {copied ? 'Copied' : 'Copy link'}
      <span className="sr-only"> for {email}</span>
    </Button>
  );
}

/** What an invite or a resend came back with: the refusal, or the link shown once with a way to revoke it. */
export function InvitationOutcome({
  slug,
  organizationId,
  state,
}: {
  slug: string;
  organizationId: string;
  state: InviteState;
}): React.JSX.Element {
  return (
    <div aria-live="polite">
      {state.status === 'refused' && <Banner tone="error">{state.message}</Banner>}
      {state.status === 'invited' && (
        <div className="space-y-2">
          {state.emailSent ? (
            <Banner tone="success">
              We emailed an invitation to {state.invitation.email} to join as {roleLabel(state.invitation.role)}.
            </Banner>
          ) : (
            <>
              <Banner tone="info">
                The invitation for {state.invitation.email} was created, but no email could be sent. Copy this link
                and send it to them yourself. It is shown only now.
              </Banner>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-[var(--color-fg)]">Invitation link</span>
                <input readOnly value={state.link} onFocus={(e) => e.currentTarget.select()} className={`${inputCls} font-mono`} />
              </label>
            </>
          )}
          <CopyLinkButton link={state.link} email={state.invitation.email} />
          <form action={revokeInvitationAction.bind(null, slug, organizationId, state.invitation.id)}>
            <ConfirmSubmit
              variant="danger"
              size="sm"
              label="Revoke"
              triggerName={`Revoke the invitation for ${state.invitation.email}`}
              title="Revoke this invitation?"
              message={`The link sent to ${state.invitation.email} will stop working.`}
              confirmLabel="Revoke invitation"
              cancelLabel="Keep it"
              pendingLabel="Revoking…"
            />
          </form>
        </div>
      )}
    </div>
  );
}

export function InviteMemberForm({
  slug,
  organizationId,
  roles,
  invite,
}: {
  slug: string;
  organizationId: string;
  /** Role names the inviter may hand out; empty to use the application's default only. */
  roles: readonly string[];
  invite: (previous: InviteState, formData: FormData) => Promise<InviteState>;
}): React.JSX.Element {
  const [state, action] = React.useActionState(invite, { status: 'idle' } as InviteState);
  return (
    <div className="space-y-3">
      <InvitationOutcome slug={slug} organizationId={organizationId} state={state} />
      <form action={action} className="space-y-3">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-fg)]">Email address</span>
          <input name="email" type="email" required autoComplete="off" className={inputCls} />
        </label>
        {roles.length > 0 && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-[var(--color-fg)]">Role</span>
            <select name="role" defaultValue="" className={inputCls}>
              <option value="">Default role</option>
              {roles.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </select>
          </label>
        )}
        <SubmitButton pendingLabel="Inviting…">Invite</SubmitButton>
      </form>
    </div>
  );
}
