import * as React from 'react';
import { fieldInputCls } from '@/components/Field';
import { PERIOD_MAX_DAYS } from '@/lib/billing-log';

/**
 * The two day inputs of a period view. A plain GET form: the period is in the
 * URL, so a view can be linked to. A period the API would refuse is refused
 * here first, with the reason under the inputs.
 */
export function PeriodForm({
  from,
  to,
  refusal,
}: {
  from: string;
  to: string;
  refusal: string | null;
}): React.JSX.Element {
  const noteId = React.useId();
  return (
    <form className="space-y-1" aria-label="Period">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">From</span>
          <input
            type="date"
            name="from"
            defaultValue={from}
            aria-describedby={noteId}
            aria-invalid={refusal !== null || undefined}
            className={fieldInputCls}
          />
        </label>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">To</span>
          <input
            type="date"
            name="to"
            defaultValue={to}
            aria-describedby={noteId}
            aria-invalid={refusal !== null || undefined}
            className={fieldInputCls}
          />
        </label>
        <button
          type="submit"
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
        >
          Apply
        </button>
      </div>
      <p
        id={noteId}
        role={refusal ? 'alert' : undefined}
        className={`text-xs ${refusal ? 'text-red-600 dark:text-red-400' : 'text-[var(--color-muted-fg)]'}`}
      >
        {refusal ?? `Both days included, in UTC. At most ${PERIOD_MAX_DAYS} days.`}
      </p>
    </form>
  );
}
