import * as React from 'react';
import type { ProfileField } from '@rekey.dev/shared-types';
import { isAnswered, isRetiredOption } from '@/lib/profile-answers';

/**
 * One answer as the Overview shows it: the value, "not answered", or a select
 * answer shown as it was given with a note that it is no longer an option.
 */
export function AnswerValue({
  field,
  answers,
}: {
  field: ProfileField;
  answers: Record<string, string | number | boolean>;
}): React.JSX.Element {
  if (!isAnswered(answers, field.key)) {
    return <span className="text-xs italic text-[var(--color-muted-fg)]">not answered</span>;
  }
  const value = answers[field.key]!;
  const shown = field.type === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
  return (
    <>
      {shown}
      {isRetiredOption(field, value) && (
        <span className="ml-2 text-xs text-[var(--color-muted-fg)]">(no longer an option)</span>
      )}
    </>
  );
}
