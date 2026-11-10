'use client';

/**
 * Resend one pending invitation. Only a hash of each link is stored, so the
 * old link cannot be shown again: resending makes a fresh one and the API
 * revokes the old. The row's own label and revoke button come in as props so
 * Resend sits beside Revoke, with what the resend returned shown underneath.
 */

import * as React from 'react';
import type { InviteState } from '@/lib/organization-actions';
import { InvitationOutcome } from './invite-member-form';
import { SubmitButton } from './submit-button';

export function ResendInvitationForm({
  slug,
  organizationId,
  email,
  resend,
  label,
  revoke,
}: {
  slug: string;
  organizationId: string;
  email: string;
  resend: (previous: InviteState) => Promise<InviteState>;
  label: React.ReactNode;
  revoke: React.ReactNode;
}): React.JSX.Element {
  const [state, action] = React.useActionState(resend, { status: 'idle' } as InviteState);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        {label}
        <div className="flex shrink-0 items-center gap-2">
          {state.status !== 'invited' && (
            <form action={action}>
              <SubmitButton variant="secondary" pendingLabel="Resending…" className="text-xs">
                Resend<span className="sr-only"> the invitation for {email}</span>
              </SubmitButton>
            </form>
          )}
          {revoke}
        </div>
      </div>
      <InvitationOutcome slug={slug} organizationId={organizationId} state={state} />
    </div>
  );
}
