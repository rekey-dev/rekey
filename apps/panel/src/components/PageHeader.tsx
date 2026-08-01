import * as React from 'react';

/**
 * Consistent page header — a title, optional description, and an optional
 * primary action aligned to the right. Every top-level page was hand-rolling
 * this `flex items-baseline justify-between` block with subtly different h1
 * sizes (text-xl here, text-2xl there) and muted-text classes; this fixes the
 * type scale + spacing in one place.
 *
 * `eyebrow` renders a small back-link / breadcrumb row above the title (used by
 * the application detail layout for "← All applications").
 *
 * `level` exists because pages nested under `/applications/{id}` sit inside a
 * layout that already emits an `<h1>` for the application name. Those pages
 * were emitting a second one, so every application sub-page shipped two `<h1>`
 * elements and a screen reader heard two competing page titles. They pass
 * `level={2}`; the visual style is unchanged either way.
 */

export function PageHeader({
  title,
  description,
  action,
  eyebrow,
  className = '',
  level = 1,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
  /** 1 for a top-level page; 2 when an ancestor layout owns the `<h1>`. */
  level?: 1 | 2;
}): React.JSX.Element {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div className={className}>
      {eyebrow && <div className="mb-2">{eyebrow}</div>}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <Heading className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">{title}</Heading>
          {description && (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-[var(--color-muted-fg)]">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}
