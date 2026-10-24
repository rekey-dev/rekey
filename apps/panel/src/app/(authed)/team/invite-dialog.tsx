import * as React from 'react';
import { Modal } from '@/components/Modal';
import { RevealActionForm } from '@/components/RevealActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { WhileUrlHas } from '@/components/WhileUrlHas';
import { ApiErrorText } from '@/components/api-error';
import { Field, fieldInputCls } from '@/components/Field';
import { APP_GRANT_LABEL, APP_GRANT_ROLES, ROLE_LABEL, ROLE_SUMMARY, assignableRoles } from '@/lib/workspace-roles';
import { invite } from './actions';

const ERR: Record<string, string> = {
  missing: 'Enter the email address of the person you want to invite.',
  TENANT_ROLE_INSUFFICIENT: 'Admins can invite members only. Ask an owner to invite an admin or owner.',
  INVITE_TARGET_ALREADY_MEMBER: 'That person is already in this workspace.',
  EMAIL_NOT_VERIFIED: 'Confirm your own email address first (check your inbox), then invite people.',
  APPLICATION_NOT_FOUND: 'One of those apps no longer exists. Pick the apps again.',
};

/**
 * "Invite people": email, a role picked from plain-language cards, the apps a
 * member gets, and one button that sends the invitation. Reopens itself on
 * `?newInvite=1` so a refused invite shows its reason inside the dialog.
 */
export function InviteDialog({
  actorRole,
  workspaceName,
  applications,
  error,
  errorDetail,
  errorFix,
}: {
  actorRole: string;
  workspaceName: string;
  applications: { id: string; name: string }[];
  error: string | undefined;
  errorDetail?: string | undefined;
  errorFix?: string | undefined;
}): React.JSX.Element {
  const roles = assignableRoles(actorRole);
  return (
    <Modal
      trigger="Invite people"
      title={`Invite someone to ${workspaceName}`}
      description="They get an email with a link to join. If they are new, they create their account from that link."
      modalKey="newInvite"
    >
      <RevealActionForm action={invite} clearParams={['newInvite']} className="group space-y-5">
        {error && (
          <WhileUrlHas param="error">
            <p
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} />
            </p>
          </WhileUrlHas>
        )}
        <Field label="Email address">
          <input
            type="email"
            name="email"
            required
            autoFocus
            autoComplete="off"
            placeholder="name@company.com"
            className={fieldInputCls}
          />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">What can they do?</legend>
          {roles.map((role, i) => (
            <label
              key={role}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] p-3 transition-colors hover:bg-[var(--color-surface-muted)] has-[:checked]:border-[var(--color-primary)] has-[:checked]:bg-[var(--color-primary-soft)]"
            >
              <input
                type="radio"
                name="role"
                value={role}
                defaultChecked={i === 0}
                className="mt-0.5 accent-[var(--color-primary)]"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{ROLE_LABEL[role]}</span>
                <span className="block text-xs text-[var(--color-muted-fg)]">{ROLE_SUMMARY[role]}</span>
              </span>
            </label>
          ))}
          {roles.length === 1 && (
            <p className="text-xs text-[var(--color-muted-fg)]">
              Admins can invite members. An owner can invite admins and other owners.
            </p>
          )}
        </fieldset>
        {/* Shown only while Member is picked: owners and admins reach every app. */}
        <fieldset className="hidden space-y-2 group-has-[[name=role][value=MEMBER]:checked]:block">
          <legend className="mb-2 text-sm font-medium">Which apps can they use?</legend>
          {applications.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-fg)]">
              This workspace has no apps yet. Once you create one, give them access on the App access tab.
            </p>
          ) : (
            applications.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] p-3 has-[input:checked]:border-[var(--color-primary)]"
              >
                <label className="flex min-w-40 flex-1 cursor-pointer items-center gap-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    name="appId"
                    value={a.id}
                    defaultChecked={applications.length === 1}
                    className="accent-[var(--color-primary)]"
                  />
                  {a.name}
                </label>
                <div className="w-48 shrink-0">
                  <select
                    name={`appRole.${a.id}`}
                    defaultValue="APP_VIEWER"
                    aria-label={`What they can do in ${a.name}`}
                    className={fieldInputCls}
                  >
                    {APP_GRANT_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {APP_GRANT_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))
          )}
        </fieldset>
        <div className="flex justify-end">
          <SubmitButton
            pendingLabel="Sending…"
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
          >
            Send invite
          </SubmitButton>
        </div>
      </RevealActionForm>
    </Modal>
  );
}
