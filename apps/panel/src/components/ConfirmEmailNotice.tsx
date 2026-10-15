import * as React from 'react';
import { Banner } from '@/components/Banner';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';

/** What the API answers when an unconfirmed operator tries one of the locked actions. */
export const EMAIL_NOT_VERIFIED_COPY =
  'Confirm your email address first. Use "Send confirmation email" in the notice at the top of the page, then open the link in that email.';

/**
 * Shown on every signed-in page while the operator's address is unconfirmed
 * and this deployment can confirm one. The API refuses the listed actions
 * until then, so say so before the operator presses a button that cannot work.
 *
 * `sendAction` is absent on a deployment that cannot send mail. The address is
 * then confirmed by signing in with a provider, which the copy says.
 */
export function ConfirmEmailNotice({
  email,
  sendAction,
}: {
  email: string;
  sendAction?: (formData: FormData) => Promise<void>;
}): React.JSX.Element {
  return (
    <Banner tone="warning" className="m-4 mb-0">
      <p className="font-medium">Confirm {email} to finish setting up your account.</p>
      <p className="mt-1">
        Until this address is confirmed you can create Applications and plans and look around, but you cannot invite
        people, change what members can do, create API keys or tokens, add webhooks, store billing, sign-in provider
        or email credentials, change where sign-in links point, add a passkey or two-factor authentication, connect
        an MCP client, or create another workspace.
      </p>
      {sendAction ? (
        <ActionForm action={sendAction} className="mt-2 flex flex-wrap items-center gap-3">
          <SubmitButton
            pendingLabel="Sending…"
            className="rounded-md border border-current px-3 py-1.5 text-sm font-medium hover:bg-amber-500/10 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Send confirmation email
          </SubmitButton>
          <span>Open the link in it in this browser, while signed in. Your password and everything else stay as they are.</span>
        </ActionForm>
      ) : (
        <p className="mt-1">
          This deployment cannot send email. Sign out and sign in with Google or GitHub to confirm the address; that
          removes your current password.
        </p>
      )}
    </Banner>
  );
}
