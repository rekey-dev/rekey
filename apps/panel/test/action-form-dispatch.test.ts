// @vitest-environment jsdom

/**
 * `ActionForm` must let React dispatch the action for the submit it received,
 * instead of cancelling the submit and calling the action itself.
 *
 * Rekey issue #569: a form that hand-dispatches its action loses the redirect
 * the action ends in. The write lands, the client fetches the destination's
 * RSC payload and gets a 200, and then drops it. The URL never changes, no
 * result is shown, and the operator reads a successful save as a failed one.
 *
 * It only shows on a production build, and only once rendering the destination
 * takes longer than the action itself, which is why every small page in the
 * panel looked fine and the Auth methods page, 14 controls over about 1970px,
 * never committed. The bisect that found it padded a committing probe page
 * with inert markup until it stopped committing, then swapped the form
 * component under an unchanged page: a plain `<form action={…}>` commits where
 * the hand-dispatching one does not.
 *
 * The mechanism is the transition. React opens one per submit it dispatches
 * (`startHostTransition`) and keeps every update the action causes inside it,
 * including the router's navigation. An action invoked by hand from `onSubmit`
 * runs outside that transition, and the navigation it triggers is discarded as
 * soon as anything else renders.
 *
 * So this reads the call stack: the action has to be reached through React's
 * own form dispatch. Asserting on the DOM instead does not separate the two,
 * because React cancels the submit event itself once it has taken it, so
 * `defaultPrevented` is true either way by the time a listener sees it. If a
 * React upgrade renames that frame this goes red, which is the same bargain
 * `action-landing.test.ts` takes with Next.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionForm } from '@/components/ActionForm';

/** React refuses to run `act` outside a test environment without this flag. */
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
});

describe('ActionForm hands the submit to React (issue #569)', () => {
  it('runs the action inside the form transition React opened for the submit', async () => {
    const stacks: string[] = [];
    let submitterValue: unknown;
    const action = (formData: FormData): void => {
      stacks.push(String(new Error('where').stack));
      submitterValue = formData.get('intent');
    };

    await act(async () => {
      root.render(
        React.createElement(
          ActionForm,
          { action },
          React.createElement('button', { type: 'submit', name: 'intent', value: 'save' }, 'Save'),
        ),
      );
    });

    const form = container.querySelector('form');
    const button = container.querySelector('button');
    expect(form, 'ActionForm did not render a form').not.toBeNull();

    await act(async () => {
      form!.requestSubmit(button);
    });

    expect(stacks.length, 'the action ran exactly once').toBe(1);
    expect(
      stacks[0],
      "The action was not reached through React's form dispatch, so it ran outside the transition React opens for a submit. The navigation that the action's redirect() causes is then dropped on a production build: the destination's RSC payload arrives with a 200 and is discarded, the URL never changes and no result is shown (issue #569).",
    ).toContain('startHostTransition');
    expect(submitterValue, "React's dispatch carries the submitter's name and value").toBe('save');
  });

  it('still lets a caller cancel the submit from its own onSubmit', async () => {
    let ran = 0;
    const action = (): void => {
      ran += 1;
    };

    await act(async () => {
      root.render(
        React.createElement(
          ActionForm,
          {
            action,
            onSubmit: (event: React.SubmitEvent<HTMLFormElement>) => event.preventDefault(),
          },
          React.createElement('button', { type: 'submit' }, 'Save'),
        ),
      );
    });

    const form = container.querySelector('form');
    const button = container.querySelector('button');
    await act(async () => {
      form!.requestSubmit(button);
    });

    expect(ran, 'a cancelled submit must not run the action').toBe(0);
  });
});
