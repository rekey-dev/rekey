'use client';

/**
 * Sticky save bar with a dirty indicator and a route-change guard.
 *
 * Built for the Auth methods page: 14 controls spread over ~1970px of scroll
 * with a single Save at the very bottom and nothing telling you there were
 * unsaved changes. Clicking any nav link discarded the lot silently, no
 * prompt, no highlight, no undo. The Access page already had the right idea
 * with an in-card save footer; this is that, made sticky and made to notice.
 *
 * Three parts, all of which have to be here rather than in the page:
 *
 * 1. **Dirty tracking.** Listens for `input`/`change` on the enclosing form and
 *    diffs against the form's *initial* values, so toggling a checkbox and
 *    toggling it back correctly reads as clean.
 * 2. **In-app navigation guard.** Next's client router doesn't fire
 *    `beforeunload`, so a `<Link>` click bypasses the browser's own protection
 *    entirely. A capture-phase click listener on the document catches anchor
 *    clicks while dirty and confirms first.
 * 3. **Full-page guard.** `beforeunload` still covers reload / close / typed
 *    URL, which the click listener cannot see.
 *
 * The guards stand down on submit so saving never trips its own guard, and
 * re-arm when the server render the save caused is committed: the page is
 * re-rendered in place (not remounted), so this component outlives the save,
 * and without re-arming it kept the pre-save baseline and ignored every later
 * edit (`test/sticky-form-footer.test.ts`).
 */

import * as React from 'react';
import { useActionPending } from './ActionForm';
import { subscribeCommittedRender } from '@/lib/render-stamp';

/**
 * Encode name and value pairs into one comparable string.
 *
 * Each part states how long the name and the value are before giving either,
 * so nothing a person can type into a field can be read as a boundary: the
 * `:`, `=` and `,` are there to keep the string legible, not to delimit it.
 * A value of `3:abc` is just a five character value, because the length that
 * precedes it already said how far it runs.
 *
 * This used to join with a literal NUL and SOH. Those are unambiguous too, but
 * they made git classify this file as binary, so every change to it rendered
 * as "Bin 6706 -> 7000 bytes" with no diff. The unsaved-changes guard below is
 * exactly the kind of code that must not change unseen.
 *
 * Exported for the tests: the snapshot is compared, never parsed back, so the
 * only property that matters is that two different sets of values cannot
 * produce the same string.
 */
export function encodeSnapshot(parts: readonly (readonly [string, string])[]): string {
  return parts.map(([name, value]) => `${name.length}:${name}=${value.length}:${value}`).join(',');
}

/** Snapshot of every named control's value, for comparison. */
function snapshot(form: HTMLFormElement): string {
  const parts: [string, string][] = [];
  for (const el of Array.from(form.elements)) {
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      if (!el.name) continue;
      const v =
        el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
          ? String(el.checked)
          : el.value;
      parts.push([el.name, v]);
    }
  }
  return encodeSnapshot(parts);
}

export function StickyFormFooter({
  label = 'Save changes',
  pendingLabel = 'Saving…',
  hint,
}: {
  label?: string;
  pendingLabel?: string;
  /** Optional line shown on the left when there is nothing to save. */
  hint?: React.ReactNode;
}): React.JSX.Element {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const [dirty, setDirty] = React.useState(false);
  const dirtyRef = React.useRef(false);
  dirtyRef.current = dirty;
  /** Set on submit so the guards stand down while the action runs. */
  const submittingRef = React.useRef(false);

  React.useEffect(() => {
    const form = anchorRef.current?.closest('form');
    if (!(form instanceof HTMLFormElement)) return;

    let initial = snapshot(form);
    const recheck = (): void => setDirty(snapshot(form) !== initial);

    // A new server render after OUR submit is the save landing (or its
    // refusal): take what the form now shows as the baseline and arm the
    // guards again. A render that arrives while the operator is editing, with
    // no submit of ours in flight, leaves their baseline alone. Deferred a
    // task so React has finished resetting the form to its new defaults.
    let rearm: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeCommittedRender(() => {
      if (!submittingRef.current) return;
      clearTimeout(rearm);
      rearm = setTimeout(() => {
        initial = snapshot(form);
        submittingRef.current = false;
        setDirty(false);
      }, 0);
    });

    form.addEventListener('input', recheck);
    form.addEventListener('change', recheck);

    const onSubmit = (): void => {
      submittingRef.current = true;
      setDirty(false);
    };
    form.addEventListener('submit', onSubmit);

    // Reload / close / typed URL.
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!dirtyRef.current || submittingRef.current) return;
      e.preventDefault();
      // Legacy requirement, some engines still need returnValue set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // In-app <Link> navigation. Capture phase, so we run before Next's own
    // handler and can stop the navigation entirely.
    const onClick = (e: MouseEvent): void => {
      if (!dirtyRef.current || submittingRef.current) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      // Same-page fragment links aren't navigation.
      const href = anchor.getAttribute('href') ?? '';
      if (href.startsWith('#')) return;
      // Don't nag when the link goes where we already are.
      if (anchor.href === window.location.href) return;

      const ok = window.confirm(
        'You have unsaved changes on this page. Leave without saving?',
      );
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onClick, true);

    return () => {
      unsubscribe();
      clearTimeout(rearm);
      form.removeEventListener('input', recheck);
      form.removeEventListener('change', recheck);
      form.removeEventListener('submit', onSubmit);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  return (
    <div ref={anchorRef} className="sticky bottom-0 z-20 -mx-1 pb-1 pt-2">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 shadow-lg backdrop-blur ${
          dirty
            ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)]'
            : 'border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)]'
        }`}
      >
        <p className="text-xs text-[var(--color-muted-fg)]" aria-live="polite">
          {dirty ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-[var(--color-fg)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" aria-hidden="true" />
              Unsaved changes
            </span>
          ) : (
            (hint ?? 'No unsaved changes.')
          )}
        </p>
        <FooterSubmit label={label} pendingLabel={pendingLabel} dirty={dirty} />
      </div>
    </div>
  );
}

/**
 * Split out so the pending hook sees the enclosing form. `useActionPending`
 * prefers the owning `ActionForm`'s flag and falls back to `useFormStatus`,
 * which only reports from inside a child of the form being submitted. See
 * `ActionForm.tsx` for why React's own flag is not safe on its own here: on
 * a production build this button was the one left reading "Saving…" forever
 * after the auth config had already been written.
 */
function FooterSubmit({
  label,
  pendingLabel,
  dirty,
}: {
  label: string;
  pendingLabel: string;
  dirty: boolean;
}): React.JSX.Element {
  const pending = useActionPending();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-60 ${
        dirty
          ? 'bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]'
          : 'border border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]'
      }`}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
