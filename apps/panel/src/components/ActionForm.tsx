'use client';

/**
 * A `<form>` whose pending state we own, rather than reading React's, and
 * whose submit React still dispatches.
 *
 * Two bugs meet in this component, and the fixes pull in opposite directions.
 *
 * ## Why the pending flag is ours (issue #567)
 *
 * When a Server Action resolves very quickly, React marks the form's boundary
 * suspended and then never replays the update, so `useFormStatus().pending`
 * stays `true` after the write has already succeeded. The button keeps its
 * pending label, stays `disabled` and keeps `aria-busy="true"` indefinitely,
 * and the operator is left believing the save failed when it did not.
 * Upstream: https://github.com/vercel/next.js/issues/53966
 *
 * It only shows up on a production build. `next dev` settles every time, which
 * is exactly why it survived so long. The panel's own writes answer in 7 to 33
 * ms, which is squarely inside the window that triggers it.
 *
 * So `pending` is a flag of our own, raised in `onSubmit` (a discrete event, so
 * it paints before the round trip starts), cleared when the action's promise
 * settles, and published through a context that `SubmitButton` prefers.
 *
 * ## Why the action is not called by hand (issue #569)
 *
 * The version before this one also submitted the form itself: `onSubmit` called
 * `preventDefault()` and invoked the action inside its own transition. That is
 * what lost the redirect. React opens a transition per submit it dispatches
 * (`startHostTransition`) and keeps every update the action causes inside it,
 * the router's navigation among them. An action invoked by hand runs outside
 * that transition, and the navigation it triggers is discarded as soon as
 * anything else renders: the destination's RSC payload arrives with a 200 and
 * is thrown away, the URL never changes and the operator sees nothing.
 *
 * On a production build that turns on how long the destination takes to render,
 * which is why it looked intermittent and page-specific. A page with a handful
 * of controls commits; the Auth methods page, 14 controls over about 1970px,
 * never did. Padding a committing probe page with inert markup is what made it
 * reproduce on demand.
 *
 * So the action React runs is `run` below, a wrapper that awaits the real one.
 * React dispatches it and the transition is React's.
 *
 * ## Why it keeps nudging after the action settles
 *
 * Dispatching through React was necessary and not sufficient. On a production
 * build the transition that re-renders the current page can still be left
 * suspended for good: React suspends on a Flight chunk still streaming in and
 * never gets the ping when it arrives. The redirect, the new table rows and
 * the flash are all in the payload and none of it reaches the screen until
 * something else updates. That is the common cause of #567 and #569, measured
 * in `lib/commit-nudge.ts`. So once the action settles, `run` nudges this
 * component until the layout's `RenderStamp` changes, which is the retry React
 * did not schedule. `test/post-action-commit.test.ts` pins it.
 *
 * ## What that costs
 *
 * The form's `action` is now a client function rather than the server-action
 * reference, so React no longer emits the URL and `$ACTION_ID` fields that let
 * a browser with JavaScript off post the form natively. That path was already
 * only nominally there (`ConfirmButton` cannot confirm, `SlugAvailabilityField`
 * cannot check and `StickyFormFooter` cannot warn without JavaScript) and a
 * silently discarded save is the worse failure of the two. `test/action-form-dispatch.test.ts`
 * pins the dispatch; `test/action-form.test.ts` pins who may read `useFormStatus`.
 */

import * as React from 'react';
import { useFormStatus } from 'react-dom';
import { useCommitNudge } from './use-commit-nudge';
import { isRedirectSignal } from '@/lib/redirect-error';

const ActionPendingContext = React.createContext<boolean | null>(null);

/**
 * Pending state for a submit control: the owning `ActionForm`'s own flag
 * when there is one, and React's `useFormStatus()` otherwise so a form
 * that has not been converted keeps behaving exactly as it did.
 */
export function useActionPending(): boolean {
  const owned = React.useContext(ActionPendingContext);
  const { pending } = useFormStatus();
  return owned ?? pending;
}

export interface ActionFormProps
  extends Omit<React.FormHTMLAttributes<HTMLFormElement>, 'action'> {
  action: (formData: FormData) => void | Promise<void>;
  ref?: React.Ref<HTMLFormElement>;
}

export function ActionForm({
  action,
  onSubmit,
  children,
  ...rest
}: ActionFormProps): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const nudge = useCommitNudge();

  // The action React runs. Wrapping it, rather than calling it ourselves from
  // `onSubmit`, is what keeps the redirect's navigation attached to the form
  // transition React opened for this submit. See the note at the top of the
  // file: a hand-dispatched action loses that navigation on any page whose
  // destination render is slower than the action itself (rekey issue #569).
  //
  // `pending` is cleared here rather than from `useFormStatus`, which is the
  // half of this component that issue #567 is about.
  async function run(formData: FormData): Promise<void> {
    try {
      await action(formData);
    } catch (err) {
      // Already applied to the router state; rethrowing only re-navigates
      // through a boundary that renders nothing meanwhile (see the note above).
      if (!isRedirectSignal(err)) throw err;
    } finally {
      setPending(false);
      // Whatever the action changed (a redirect, a revalidated page) is in the
      // payload by now or soon will be; make sure it gets committed.
      nudge.start();
    }
  }

  function handleSubmit(event: React.SubmitEvent<HTMLFormElement>): void {
    onSubmit?.(event);
    // A caller's own handler may cancel the submit, which is how
    // ConfirmButton-style "are you sure" prompts back out. React skips its own
    // dispatch for a submit whose default was prevented, so there is nothing
    // left to stop.
    if (event.defaultPrevented) return;
    nudge.mark();
    // A discrete event, so this paints before the action's round trip starts.
    setPending(true);
  }

  return (
    <ActionPendingContext.Provider value={pending}>
      <form action={run} onSubmit={handleSubmit} {...rest}>
        {children}
      </form>
    </ActionPendingContext.Provider>
  );
}
