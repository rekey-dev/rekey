'use client';

import * as React from 'react';
import { CONTACT_FIELD_TYPES, type ContactFieldDef, type ContactFieldType } from '@rekey.dev/shared-types';
import { fieldInputCls } from './Field';

/**
 * Rows of extra fields a list collects beyond the address. Posts them as JSON
 * in one hidden input, `fieldSchema`, which the server action parses with
 * `parseFieldSchema`.
 */

interface Row {
  id: number;
  name: string;
  label: string;
  type: ContactFieldType;
  required: boolean;
  options: string;
  /** Not edited here; kept so a save does not reset it. */
  maxLength: number | undefined;
}

const TYPE_LABEL: Record<ContactFieldType, string> = {
  text: 'Short text',
  textarea: 'Long text',
  email: 'Email',
  url: 'Link',
  select: 'Choice',
  checkbox: 'Checkbox',
  number: 'Number',
};

const inputCls = `${fieldInputCls} text-[var(--color-fg)]`;

export function ListFieldsEditor({ initial }: { initial: ReadonlyArray<ContactFieldDef> }): React.JSX.Element {
  const nextId = React.useRef(initial.length);
  const [rows, setRows] = React.useState<Row[]>(() =>
    initial.map((d, i) => ({
      id: i,
      name: d.name,
      label: d.label,
      type: d.type,
      required: d.required,
      options: (d.options ?? []).join(', '),
      maxLength: d.maxLength,
    })),
  );

  const serialised = JSON.stringify(
    rows.map((r) => ({
      name: r.name.trim(),
      label: r.label.trim(),
      type: r.type,
      required: r.required,
      ...(r.maxLength !== undefined && { maxLength: r.maxLength }),
      ...(r.type === 'select' && {
        options: r.options
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      }),
    })),
  );

  const update = (id: number, patch: Partial<Row>): void =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-2">
      <input type="hidden" name="fieldSchema" value={serialised} />
      {rows.length === 0 && (
        <p className="text-xs text-[var(--color-muted-fg)]">
          Only the email address, and a name if the form sends one. Add a field for anything else, such as a
          contact form message.
        </p>
      )}
      {rows.map((r) => (
        <div key={r.id} className="grid items-start gap-2 sm:grid-cols-[9rem_1fr_9rem_1fr_auto_auto]">
          <input
            aria-label="Field name"
            placeholder="message"
            value={r.name}
            maxLength={40}
            onChange={(e) => update(r.id, { name: e.target.value })}
            className={`${inputCls} font-mono`}
          />
          <input
            aria-label="Label"
            placeholder="Your message"
            value={r.label}
            maxLength={120}
            onChange={(e) => update(r.id, { label: e.target.value })}
            className={inputCls}
          />
          <select
            aria-label="Type"
            value={r.type}
            onChange={(e) => update(r.id, { type: e.target.value as ContactFieldType })}
            className={inputCls}
          >
            {CONTACT_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <input
            aria-label="Choices, comma separated"
            placeholder={r.type === 'select' ? 'solo, team' : 'Choices (for Choice only)'}
            value={r.options}
            disabled={r.type !== 'select'}
            onChange={(e) => update(r.id, { options: e.target.value })}
            className={inputCls}
          />
          <label className="flex min-h-[2.375rem] items-center gap-1.5 text-xs">
            <input type="checkbox" checked={r.required} onChange={(e) => update(r.id, { required: e.target.checked })} />
            Required
          </label>
          <button
            type="button"
            onClick={() => setRows((current) => current.filter((x) => x.id !== r.id))}
            className="min-h-[2.375rem] rounded-md px-2 text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setRows((current) => [
            ...current,
            { id: nextId.current++, name: '', label: '', type: 'text', required: false, options: '', maxLength: undefined },
          ])
        }
        className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
      >
        Add field
      </button>
    </div>
  );
}
