import * as React from 'react';

type CardElement = 'div' | 'section' | 'li' | 'article';

export function Card({
  children,
  className = '',
  padded = true,
  as = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
  as?: CardElement;
}): React.JSX.Element {
  const Tag = as;
  const cls = [
    'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]',
    padded ? 'p-5' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <Tag className={cls}>{children}</Tag>;
}

export function SectionHeader({
  title,
  count,
  description,
  action,
  className = '',
}: {
  title: React.ReactNode;
  count?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">
          {title}
          {count !== undefined && count !== null && (
            <span className="ml-1.5 font-normal text-[var(--color-muted-fg)]">{count}</span>
          )}
        </h2>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted-fg)]">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
