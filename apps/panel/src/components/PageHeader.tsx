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
 */

export function PageHeader({
  title,
  description,
  action,
  eyebrow,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={className}>
      {eyebrow && <div className="mb-2">{eyebrow}</div>}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">{title}</h1>
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
