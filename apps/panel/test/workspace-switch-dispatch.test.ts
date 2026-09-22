// @vitest-environment jsdom
/**
 * A workspace switch goes through `ActionForm`, not a hand-called action.
 *
 * `WorkspaceSwitcher` rendered its hidden form as an `ActionForm` but still
 * called `switchAction(formData)` itself inside `startTransition`, so the
 * wrapper was never submitted: no React-dispatched transition for the
 * redirect (#569) and no post-action nudge (`lib/commit-nudge.ts`). Same
 * stack check as `action-form-dispatch.test.ts`.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';

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

describe('WorkspaceSwitcher', () => {
  it("submits the switch through ActionForm, inside React's form transition", async () => {
    const calls: { stack: string; tenantId: unknown }[] = [];
    const switchAction = async (formData: FormData): Promise<void> => {
      calls.push({ stack: String(new Error('where').stack), tenantId: formData.get('tenantId') });
    };
    await act(async () => {
      root.render(
        React.createElement(WorkspaceSwitcher, {
          memberships: [
            { tenantId: 't1', tenantName: 'One', role: 'OWNER', scopes: null },
            { tenantId: 't2', tenantName: 'Two', role: 'ADMIN', scopes: null },
          ],
          activeTenantId: 't1',
          switchAction,
        } as unknown as React.ComponentProps<typeof WorkspaceSwitcher>),
      );
    });
    await act(async () => {
      (container.querySelector('button[title="One"]') as HTMLButtonElement).click();
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], button, li')].find(
      (el) => el.textContent?.includes('Two') && el.textContent.includes('ADMIN'),
    );
    expect(item, 'the dropdown did not render the second workspace').toBeDefined();
    await act(async () => {
      item!.click();
    });
    expect(calls, 'the switch action was not called').toHaveLength(1);
    expect(calls[0]!.tenantId).toBe('t2');
    expect(
      calls[0]!.stack,
      "The switch action was called by hand, outside the transition React opens for a form submit, so ActionForm's redirect handling and post-action nudge never applied.",
    ).toContain('startHostTransition');
  });
});
