import * as React from 'react';
import { ROLE_ABILITIES, ROLE_LABEL, type WorkspaceRole } from '@/lib/workspace-roles';

const ORDER: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER'];

/** What each workspace role can and cannot do, side by side. */
export function RoleGuide({ open = false }: { open?: boolean }): React.JSX.Element {
  return (
    <details
      open={open}
      className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-medium">
        What can each role do?
        <span aria-hidden className="text-[var(--color-muted-fg)] transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="grid gap-4 border-t border-[var(--color-border)] p-5 sm:grid-cols-3">
        {ORDER.map((role) => (
          <div key={role} className="space-y-2">
            <h3 className="text-sm font-semibold">{ROLE_LABEL[role]}</h3>
            <ul className="space-y-1 text-sm">
              {ROLE_ABILITIES[role].can.map((line) => (
                <li key={line} className="flex gap-2">
                  <span aria-hidden className="text-emerald-600 dark:text-emerald-400">✓</span>
                  <span>{line}</span>
                </li>
              ))}
              {ROLE_ABILITIES[role].cannot.map((line) => (
                <li key={line} className="flex gap-2 text-[var(--color-muted-fg)]">
                  <span aria-hidden>✕</span>
                  <span>
                    <span className="sr-only">Cannot: </span>
                    {line}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
