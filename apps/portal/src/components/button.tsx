/**
 * Button primitive, two variants. `--color-primary` and its hover are
 * operator-brandable (layout.tsx overrides them). The keyboard focus outline
 * comes from globals.css, as for every interactive element.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-primary)] font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-50',
  secondary:
    'border border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-surface)] disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  return (
    <button
      className={[
        'min-h-11 rounded-md px-3 py-2 text-sm',
        VARIANTS[variant],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}
