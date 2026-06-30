import * as React from 'react';

export function PageHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] pb-5">
      <div className="min-w-0">
        <h1
          className="text-2xl font-semibold leading-tight tracking-tight"
          style={{ fontFamily: 'var(--font-feature), ui-serif, Georgia, serif' }}
        >
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-3xl text-sm text-[var(--color-muted-fg)]">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
