import * as React from 'react';
import { ActionForm } from '@/components/ActionForm';
import { ConfirmButton } from '@/components/ConfirmButton';
import { setListArchived } from './actions';
import { dangerButtonClass } from '@/components/Button';

const TRIGGER =
  'inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

/** Archive or restore, always behind a confirmation that says what changes. */
export function ArchiveListButton({
  applicationId,
  listId,
  name,
  archived,
}: {
  applicationId: string;
  listId: string;
  name: string;
  archived: boolean;
}): React.JSX.Element {
  return (
    <ActionForm action={setListArchived.bind(null, applicationId, listId, !archived)} className="inline">
      {archived ? (
        <ConfirmButton
          variant="subtle"
          title={`Restore ${name}?`}
          confirm="People can subscribe again through every form that uses this list, and it counts toward your workspace's list limit again."
          confirmLabel="Restore list"
          triggerClassName={TRIGGER}
        >
          Restore
        </ConfirmButton>
      ) : (
        <ConfirmButton
          title={`Archive ${name}?`}
          confirm="Every form that writes to this list stops working until you restore it. Members, submissions and the key are kept."
          confirmLabel="Archive list"
          triggerClassName={dangerButtonClass('sm')}
        >
          Archive
        </ConfirmButton>
      )}
    </ActionForm>
  );
}
