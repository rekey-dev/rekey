'use client';

/**
 * A form whose action mints a one-time secret, and the dialog that shows it.
 *
 * Every secret the panel mints (API keys, webhook signing secrets, invite
 * links, licence keys, personal access tokens, impersonation tokens) used to
 * reach the screen the same way: the action parked it in a short-lived
 * httpOnly cookie, redirected, and the next render of the page read the cookie
 * and drew a banner. That only works if the redirect's render is committed, and
 * on a production build it often was not (`lib/commit-nudge.ts`): the key was
 * minted, counted against the cap, and never shown. Two of the forms reloaded
 * the whole document to force it, which worked and cost the operator the page.
 * (That reload, `reloadOnSettle`, is gone: `ActionForm` now gets its redirects
 * committed, see `lib/commit-nudge.ts`.)
 *
 * Here the action RETURNS the secret, and this component keeps it in its own
 * state and opens a dialog with it. A state update after the action's promise
 * resolves is an ordinary update, not part of the form transition, so it is
 * committed whether or not the page's own re-render ever is. The secret
 * travels once, in the body of the action's POST response: never in a URL,
 * never in a cookie, never in the page's RSC payload, and it is dropped from
 * memory when the dialog closes.
 *
 * The action still decides everything else. A refusal redirects back with
 * `?error=` exactly as before, and a success calls `revalidatePath` so the
 * table behind the dialog already has the new row. That pairing (revalidate,
 * no redirect) is the one `(authed)/layout.tsx` sanctions; it is
 * `revalidatePath` plus `redirect()` that blanks the page.
 *
 * `test/one-time-secret.test.ts` pins the rules for every minting action.
 */

import * as React from 'react';
import { ActionForm, type ActionFormProps } from './ActionForm';
import { CopyButton } from './CopyButton';
import { ModalHeader, dialogChromeCls } from './Modal';
import { FLAG_EVENTS, track } from '@/lib/analytics';
import type { OneTimeSecret, RevealResult } from '@/lib/one-time-secret';

export type { OneTimeSecret, RevealResult };

export interface RevealActionFormProps extends Omit<ActionFormProps, 'action'> {
  action: (formData: FormData) => Promise<RevealResult>;
  /**
   * Query flags a refusal on this form leaves behind, dropped when a mint
   * succeeds. `error` is always dropped; name the others (`impError`, the
   * webhook form's `url`).
   */
  clearParams?: string[];
}

/**
 * Drop a refusal's flags from the address bar once a mint has succeeded.
 *
 * Refusals redirect to `?error=…`; a success revalidates without navigating,
 * so the URL, and every banner drawn from it, kept saying the previous attempt
 * was refused ("A key name is required." beside a freshly minted key), which
 * reads as "try again" against a cap. A native `replaceState` like
 * `SavedBanner`'s, not a navigation: Next reflects it into `useSearchParams`,
 * and the banners are wrapped in `WhileUrlHas`.
 */
export function dropRefusalFlags(params: readonly string[]): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const name of ['error', ...params]) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (changed) window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function RevealActionForm({ action, clearParams = [], children, ...rest }: RevealActionFormProps): React.JSX.Element {
  const [secret, setSecret] = React.useState<OneTimeSecret | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  async function run(formData: FormData): Promise<void> {
    const result = await action(formData);
    if (!result?.secret) return;
    dropRefusalFlags(clearParams);
    setSecret(result.secret);
    const mapped = result.secret.flag ? FLAG_EVENTS[result.secret.flag] : undefined;
    if (mapped) track(mapped.event, mapped.params);
  }

  function done(): void {
    setSecret(null);
    // A form that lives in a `Modal` has done its job; close that too, so the
    // operator lands on the page (and its new row), not on an emptied form.
    const host = formRef.current?.closest('dialog');
    if (host?.open) host.close();
  }

  return (
    <>
      <ActionForm ref={formRef} action={run} {...rest}>
        {children}
      </ActionForm>
      {secret && <SecretDialog secret={secret} onDone={done} />}
    </>
  );
}

/**
 * The one-time reveal itself. Opened as a modal the moment it mounts, and
 * closed only on purpose: the backdrop does nothing, and Esc asks first until
 * the secret has been copied, because closing it is the last chance to have it.
 */
export function SecretDialog({ secret, onDone }: { secret: OneTimeSecret; onDone: () => void }): React.JSX.Element {
  const ref = React.useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = React.useState(false);
  const titleId = React.useId();
  const descId = React.useId();

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    try {
      dialog.showModal();
    } catch {
      /* detached or already open */
    }
  }, []);

  function close(): void {
    if (ref.current?.open) ref.current.close();
    onDone();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descId}
      className={dialogChromeCls('md')}
      data-one-time-secret=""
      onCancel={(e) => {
        e.preventDefault();
        if (copied || window.confirm('Close without copying? This is the only time it is shown.')) close();
      }}
    >
      <ModalHeader titleId={titleId} title={secret.title} onClose={() => {
        if (copied || window.confirm('Close without copying? This is the only time it is shown.')) close();
      }} />
      <div className="space-y-4 p-6">
        <p
          id={descId}
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/60 dark:bg-amber-950/60 dark:text-amber-200"
        >
          <strong>Shown once.</strong> Copy it now and keep it somewhere safe. Once this dialog is
          closed it cannot be shown again.
        </p>
        <div className="flex items-start gap-2">
          <code className="block min-w-0 flex-1 break-all rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs">
            {secret.value}
          </code>
          <CopyButton value={secret.value} label="Copy" onCopied={() => setCopied(true)} />
        </div>
        {secret.notes?.map((note) => (
          <p key={note} className="text-xs text-[var(--color-muted-fg)]">
            {note}
          </p>
        ))}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={close}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          >
            {copied ? 'Done' : "I've stored it"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
