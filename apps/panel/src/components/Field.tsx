import * as React from 'react';

/**
 * Form field primitive — labeled `<input>` (or `<select>`, `<textarea>`)
 * with an optional helper hint underneath. See design.md §11.
 *
 * Usage:
 *   <Field label="Slug" hint="URL-safe identifier" required>
 *     <input name="slug" className={fieldInputCls + ' font-mono'} />
 *   </Field>
 *
 * The Field component itself doesn't render the input — callers pass the
 * input element so they keep control of `name`, `defaultValue`, `pattern`,
 * autoFocus, etc. `fieldInputCls` is the canonical input className from
 * design.md so callers compose with one extra class instead of repeating
 * the whole string.
 */

export const fieldInputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

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
   * findable at a glance — not just from a page-top banner.
   */
  error?: string;
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
      <span className="text-xs font-medium text-[var(--color-fg)]">
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
