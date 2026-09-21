'use client';

/**
 * Workspace switcher, shadcn-style dropdown with inline create-workspace
 * modal. Replaces the old native `<select>` (which broke styling on long
 * names + couldn't host a modal trigger naturally).
 *
 * Two server actions threaded in from the (authed)/layout.tsx:
 *   - switchAction(formData) , POSTed when user picks a different workspace
 *   - createAction(formData) , POSTed from the inline "+ New workspace" modal
 *
 * Both bounce server-side (redirect after action), so no client state to
 * keep in sync, the dropdown closes when the navigation happens.
 */

import * as React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { Modal } from './Modal';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

interface Membership {
  tenantId: string;
  tenantName: string;
  role: string;
}

export function WorkspaceSwitcher({
  memberships,
  activeTenantId,
  switchAction,
  createAction,
}: {
  memberships: Membership[];
  activeTenantId: string;
  switchAction: (formData: FormData) => Promise<void>;
  /**
   * Omitted when this deployment does not allow additional workspaces
   * (`WORKSPACE_CREATION=disabled`). The entry and its modal are then not
   * rendered at all, an operator is never shown a door that will not open.
   */
  createAction?: ((formData: FormData) => Promise<void>) | undefined;
}): React.JSX.Element {
  // Hidden form so any DropdownMenuItem can start a switch by setting the
  // tenantId input, and so a browser with no JavaScript still has a native
  // post target. The FormData we hand the action is read off this element.
  const formRef = React.useRef<HTMLFormElement | null>(null);
  const tenantIdInputRef = React.useRef<HTMLInputElement | null>(null);
  // Same trick for the modal's create form trigger.
  const newModalTriggerRef = React.useRef<HTMLButtonElement | null>(null);

  // Pending feedback: the switch is a full server round-trip, so without this
  // the picked item just sits inert until navigation lands.
  //
  // The flag used to have no way back down: it was set, the form was
  // `requestSubmit()`ed, and the only thing that ever cleared it was the
  // component being remounted by the navigation the action ends in. A switch
  // whose navigation does not commit therefore left the trigger reading
  // "Switching…", disabled, until the operator reloaded the page by hand. So
  // we call the action ourselves and clear the flag when its promise settles,
  // the same bargain `ActionForm` makes for a form with a submit button in it.
  // The action is started inside a transition so the router has one to
  // navigate with, and the promise chain is left outside that transition on
  // purpose: an action ending in `redirect()` puts the navigation into
  // whichever transition dispatched it, and it is the navigation, not the
  // write, that can hang.
  const [switching, setSwitching] = React.useState(false);
  const [, startTransition] = React.useTransition();

  function switchTo(tenantId: string): void {
    if (tenantId === activeTenantId || switching) return;
    const form = formRef.current;
    const input = tenantIdInputRef.current;
    if (!form || !input) return;
    input.value = tenantId;
    const formData = new FormData(form);
    setSwitching(true);
    startTransition(() => {
      void Promise.resolve(switchAction(formData)).finally(() => {
        setSwitching(false);
      });
    });
  }

  const active = memberships.find((m) => m.tenantId === activeTenantId);
  const triggerLabel = active?.tenantName ?? 'Workspace';

  return (
    <>
      {/* Hidden form drives the switch action. */}
      <form ref={formRef} action={switchAction} className="hidden">
        <input ref={tenantIdInputRef} type="hidden" name="tenantId" defaultValue={activeTenantId} />
      </form>

      <DropdownMenu>
        <DropdownMenuTrigger>
          <button
            type="button"
            title={triggerLabel}
            disabled={switching}
            aria-busy={switching}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-60"
          >
            <span className="truncate">{switching ? 'Switching…' : triggerLabel}</span>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--color-faint-fg)]">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-[14rem]">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {memberships.map((m) => (
            <DropdownMenuItem
              key={m.tenantId}
              active={m.tenantId === activeTenantId}
              onSelect={() => switchTo(m.tenantId)}
            >
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span title={m.tenantName} className="truncate">{m.tenantName}</span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-faint-fg)] shrink-0">
                  {m.role}
                </span>
              </div>
            </DropdownMenuItem>
          ))}
          {createAction && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => newModalTriggerRef.current?.click()}>
                <span className="text-[var(--color-primary)] font-medium">+ New workspace…</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The "+ New workspace" entry triggers this Modal. We ref the Modal's
          own (hidden) trigger button so the dropdown item can .click() it
          programmatically, no nested <button>. */}
      {createAction && (
        <Modal
          title="Create workspace"
          description="Workspaces are isolated: applications, members, billing creds, and API keys don't leak between them."
          trigger="open"
          triggerClassName="hidden"
          triggerRef={newModalTriggerRef}
        >
          <ActionForm action={createAction} className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium">Workspace name</span>
              <input
                type="text"
                name="name"
                required
                autoFocus
                minLength={2}
                maxLength={80}
                placeholder="Side project"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
              />
              <span className="block text-xs text-[var(--color-muted-fg)]">
                You'll be the OWNER. Invite teammates from the Team page after.
              </span>
            </label>
            <SubmitButton pendingLabel="Creating workspace…">Create + switch</SubmitButton>
          </ActionForm>
        </Modal>
      )}
    </>
  );
}
