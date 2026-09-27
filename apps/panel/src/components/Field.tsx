import * as React from 'react';

/**
 * Form field primitive, labeled `<input>` (or `<select>`, `<textarea>`)
 * with an optional helper hint underneath.
 *
 * Usage:
 *   <Field label="Slug" hint="URL-safe identifier" required>
 *     <input name="slug" className={fieldInputCls + ' font-mono'} />
 *   </Field>
 *
 * The Field component itself doesn't render the input, callers pass the
 * input element so they keep control of `name`, `defaultValue`, `pattern`,
 * autoFocus, etc. `fieldInputCls` is the canonical input className, so
 * callers compose with one extra class instead of repeating the whole string.
 */

/**
 * `min-h` matches a text input's natural height. A `<select>` with the same
 * padding renders 1.5px shorter, which left mixed rows with ragged bottoms.
 */
export const fieldInputCls =
  'min-h-[2.375rem] w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

/**
 * The label text of every Field. `FieldRowAction` renders an invisible copy of
 * the label line, so the two stay the same height by construction.
 */
const fieldLabelCls = 'text-xs font-medium text-[var(--color-fg)]';

/**
 * Container classes for a row of Fields that sits on one line from `sm` up
 * and stacks below it. Callers add the column template, e.g.
 * `sm:grid-cols-[1fr_10rem_auto]`.
 *
 * The row aligns its items to the top, not the bottom. With `items-end`, a
 * hint or error under one control pushed that field's label and control up
 * past its siblings. Top-aligned, every label starts on the same line and
 * every control directly under it, and whatever renders below a control only
 * grows its own field downward.
 *
 * @example
 * ```tsx
 * <ActionForm action={add} className={`${fieldRowCls} sm:grid-cols-[1fr_1fr_auto]`}>
 *   <Field label="Address" required><input name="address" className={fieldInputCls} /></Field>
 *   <Field label="Note" hint="Optional."><input name="note" className={fieldInputCls} /></Field>
 *   <FieldRowAction><SubmitButton>Add</SubmitButton></FieldRowAction>
 * </ActionForm>
 * ```
 */
export const fieldRowCls = 'grid items-start gap-2';

/**
 * Holds a row's button level with the controls rather than the labels, by
 * reserving one label line above it. The reserved line is dropped below `sm`,
 * where `fieldRowCls` stacks the row and the button follows the last field,
 * full width like the controls above it.
 */
export function FieldRowAction({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid">
      <span aria-hidden className="invisible hidden sm:mb-1 sm:block">
        <span className={fieldLabelCls}>&nbsp;</span>
      </span>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  required?: boolean;
  /**
   * Per-field validation error. When set, the message renders below the
   * input with `role="alert"` and the child input (when it's a single
   * element) gets `aria-invalid` + a red border, so the broken field is
   * findable at a glance, not just from a page-top banner.
   */
  error?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  let content = children;
  if (error && React.isValidElement<{ className?: string; 'aria-invalid'?: boolean }>(children)) {
    const prevCls = children.props.className ?? '';
    content = React.cloneElement(children, {
      'aria-invalid': true,
      className: `${prevCls} border-red-500 dark:border-red-500 focus:border-red-500 focus:ring-red-500/30`,
    });
  }
  return (
    <label className="block space-y-1">
      <span className={fieldLabelCls}>
        {label}
        {required && <span className="text-[var(--color-primary)] ml-0.5">*</span>}
      </span>
      {content}
      {error && (
        <span role="alert" className="block text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
      {hint && !error && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}
