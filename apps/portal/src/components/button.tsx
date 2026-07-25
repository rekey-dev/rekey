/**
 * Button primitive — two variants matching the hand-rolled styles already in
 * use ([slug]/login/page.tsx primary submit, [slug]/layout.tsx sign-out), plus
 * a keyboard focus ring. `--color-primary` is operator-brandable (layout.tsx
 * overrides it), so both the fill and the ring track the brand.
 *
 * Tailwind 3 can't apply an opacity modifier to a var() arbitrary value
 * (`ring-[color-mix(in_srgb,var(--x)_40%,transparent)]` emits nothing), so the ring tint uses color-mix.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-primary)] font-medium text-[var(--color-primary-fg)] disabled:opacity-50',
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
        'rounded-md px-3 py-2 text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_40%,transparent)]',
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
