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

import { roleLabel } from '@/lib/workspace-roles';
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
  // The switch goes through the hidden `ActionForm` below with
  // `requestSubmit()`, so React dispatches it and `ActionForm` does what it
  // does for every other form: keeps the redirect's navigation in React's own
  // transition, and nudges the render until it commits (`lib/commit-nudge.ts`).
  // This used to call the action by hand inside `startTransition`, which got
  // neither. The flag is cleared in the wrapped action's `finally`, so a
  // switch that fails does not leave the trigger reading "Switching…".
  const [switching, setSwitching] = React.useState(false);

  async function runSwitch(formData: FormData): Promise<void> {
    try {
      await switchAction(formData);
    } finally {
      setSwitching(false);
    }
  }

  function switchTo(tenantId: string): void {
    if (tenantId === activeTenantId || switching) return;
    const form = formRef.current;
    const input = tenantIdInputRef.current;
    if (!form || !input) return;
    input.value = tenantId;
    setSwitching(true);
    form.requestSubmit();
  }

  const active = memberships.find((m) => m.tenantId === activeTenantId);
  const triggerLabel = active?.tenantName ?? 'Workspace';

  return (
    <>
      {/* Hidden form drives the switch action. */}
      <ActionForm ref={formRef} action={runSwitch} className="hidden">
        <input ref={tenantIdInputRef} type="hidden" name="tenantId" defaultValue={activeTenantId} />
      </ActionForm>

      <DropdownMenu>
        <DropdownMenuTrigger>
          <button
            type="button"
            title={triggerLabel}
            disabled={switching}
            aria-busy={switching}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
          >
            <span
              aria-hidden="true"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-primary-soft)] text-xs font-semibold text-[var(--color-primary-soft-fg)]"
            >
              {triggerLabel.trim().charAt(0).toUpperCase() || 'W'}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium text-[var(--color-fg)]">
                {switching ? 'Switching…' : triggerLabel}
              </span>
              {active && (
                <span className="block text-[11px] capitalize text-[var(--color-muted-fg)]">
                  {active.role.toLowerCase()}
                </span>
              )}
            </span>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--color-faint-fg)]">
              <path d="m7 15 5 5 5-5" />
              <path d="m7 9 5-5 5 5" />
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
                <span className="text-[11px] text-[var(--color-muted-fg)] shrink-0">
                  {roleLabel(m.role)}
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
          description="A workspace is a separate home for a business: its own apps, team, billing and keys, kept apart from your other workspaces."
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
                You'll be its owner. Invite your team from the Team page afterwards.
              </span>
            </label>
            <SubmitButton pendingLabel="Creating workspace…">Create and open</SubmitButton>
          </ActionForm>
        </Modal>
      )}
    </>
  );
}
