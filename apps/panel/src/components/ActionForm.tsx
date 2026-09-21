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
 * React dispatches it, the transition is React's, and the redirect commits.
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
  /**
   * Reload the page once the action has settled, instead of leaving the
   * operator on the render they submitted from.
   *
   * Opt-in, and only for a form whose result the page can show on a fresh
   * render and nowhere else: the value is waiting in a one-time cookie scoped
   * to the path the submit came from, and a client navigation to the redirect
   * target would not read it.
   *
   * This used to be the workaround for issue #569, dropped redirects, on the
   * theory that a document navigation was the only thing that landed. It is
   * not needed for that any more: the redirect commits now that React
   * dispatches the submit (see the note at the top of this file). The three
   * forms that still set it do so for the cookie, which is its own reason.
   *
   * Deliberately NOT set on the `StickyFormFooter` config forms. Their
   * `?saved=1` redirect is load-bearing (panel issue #23) and they already
   * clear their own dirty state; a reload there would throw away scroll
   * position and collide with the unsaved-changes guard.
   */
  reloadOnSettle?: boolean;
}

export function ActionForm({
  action,
  onSubmit,
  reloadOnSettle = false,
  children,
  ...rest
}: ActionFormProps): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const hrefAtSubmit = React.useRef('');

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
    } finally {
      setPending(false);
      // `href` as it was at submit, not the redirect's target: the target
      // carries throwaway flags, and on the forms that opt in the result is
      // waiting in a cookie scoped to the path we came from.
      if (reloadOnSettle) window.location.assign(hrefAtSubmit.current);
    }
  }

  function handleSubmit(event: React.SubmitEvent<HTMLFormElement>): void {
    onSubmit?.(event);
    // A caller's own handler may cancel the submit, which is how
    // ConfirmButton-style "are you sure" prompts back out. React skips its own
    // dispatch for a submit whose default was prevented, so there is nothing
    // left to stop.
    if (event.defaultPrevented) return;
    hrefAtSubmit.current = window.location.href;
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
