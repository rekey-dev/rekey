'use client';

import * as React from 'react';
import type { CustomEmailVariableDef, CustomEmailVariableType } from '@rekey.dev/shared-types';
import { fieldInputCls } from './Field';

/**
 * Rows of declared variables for a custom email template. Posts them as JSON
 * in one hidden field, `variableSchema`, which the server action parses with
 * `parseVariableSchema`.
 */

interface Row {
  id: number;
  name: string;
  type: CustomEmailVariableType;
  required: boolean;
  maxLength: number;
  sample: string;
}

const TYPES: ReadonlyArray<{ value: CustomEmailVariableType; label: string }> = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'url', label: 'Link (https)' },
  { value: 'date', label: 'Date (ISO)' },
];

const inputCls = `${fieldInputCls} text-[var(--color-fg)]`;

export function VariableSchemaEditor({
  initial,
  name = 'variableSchema',
}: {
  initial: ReadonlyArray<CustomEmailVariableDef>;
  name?: string;
}): React.JSX.Element {
  const nextId = React.useRef(initial.length);
  const [rows, setRows] = React.useState<Row[]>(() =>
    initial.map((d, i) => ({
      id: i,
      name: d.name,
      type: d.type,
      required: d.required,
      maxLength: d.maxLength,
      sample: d.sample ?? '',
    })),
  );

  const serialised = JSON.stringify(
    rows.map((r) => ({
      name: r.name.trim(),
      type: r.type,
      required: r.required,
      maxLength: r.maxLength,
      ...(r.sample.trim() !== '' && { sample: r.sample }),
    })),
  );

  const update = (id: number, patch: Partial<Row>): void =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={serialised} />
      {rows.length === 0 && (
        <p className="text-xs text-[var(--color-muted-fg)]">
          No variables yet. Add one for each value your backend passes when it sends.
        </p>
      )}
      {rows.map((r) => (
        <div key={r.id} className="grid items-start gap-2 sm:grid-cols-[1fr_9rem_6rem_1fr_auto_auto]">
          <input
            aria-label="Variable name"
            placeholder="orderNumber"
            value={r.name}
            maxLength={64}
            onChange={(e) => update(r.id, { name: e.target.value })}
            className={`${inputCls} font-mono`}
          />
          <select
            aria-label="Type"
            value={r.type}
            onChange={(e) => update(r.id, { type: e.target.value as CustomEmailVariableType })}
            className={inputCls}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Maximum length"
            type="number"
            min={1}
            max={2048}
            value={r.maxLength}
            onChange={(e) => update(r.id, { maxLength: Number(e.target.value) || 1 })}
            className={inputCls}
          />
          <input
            aria-label="Sample value for previews"
            placeholder="Sample for previews"
            value={r.sample}
            maxLength={2048}
            onChange={(e) => update(r.id, { sample: e.target.value })}
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
            { id: nextId.current++, name: '', type: 'string', required: false, maxLength: 256, sample: '' },
          ])
        }
        className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
      >
        Add variable
      </button>
    </div>
  );
}
