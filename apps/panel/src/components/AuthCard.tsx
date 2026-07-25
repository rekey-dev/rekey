import * as React from 'react';

/**
 * Shared centered shell for the signed-out auth pages (login, sign-up,
 * magic-link, forgot/reset password): full-height gradient backdrop with a
 * max-w-md surface card and a consistent text-2xl title scale.
 *
 * Pass `action` to render the card element itself as a <form> (single-form
 * pages); omit it for pages that nest multiple forms inside the card.
 */
export function AuthCard({
  title,
  subtitle,
  action,
  spacing = 'md',
  className = '',
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** Server action — when given, the card element is a <form>. */
  action?: (formData: FormData) => Promise<void>;
  /** Vertical rhythm between card children: 'sm' = space-y-4, 'md' = space-y-5. */
  spacing?: 'sm' | 'md';
  className?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const cardCls = [
    'w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm',
    spacing === 'sm' ? 'space-y-4' : 'space-y-5',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const header = subtitle ? (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-sm text-[var(--color-muted-fg)]">{subtitle}</p>
    </div>
  ) : (
    <h1 className="text-2xl font-semibold">{title}</h1>
  );
  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
      {action ? (
        <form action={action} className={cardCls}>
          {header}
          {children}
        </form>
      ) : (
        <div className={cardCls}>
          {header}
          {children}
        </div>
      )}
    </main>
  );
}

/** "── or ──" separator between alternative sign-in methods on an AuthCard. */
export function OrDivider(): React.JSX.Element {
  return (
    <div className="relative">
      <div className="absolute inset-0 flex items-center" aria-hidden="true">
        <div className="w-full border-t border-[var(--color-border)]" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-[var(--color-surface)] px-2 text-xs text-[var(--color-muted-fg)]">or</span>
      </div>
    </div>
  );
}
