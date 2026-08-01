import * as React from 'react';

/**
 * Single button primitive — three variants, two sizes. See design.md §10.
 *
 * Why a primitive: every page was hand-rolling the same Tailwind classes,
 * and bulk-swapping them when we changed the brand color was tedious. One
 * source of truth here.
 *
 * Use as `<Button>` for native button semantics, or pass `as="span"` to
 * embed inside something that already supplies a click handler (e.g. the
 * Modal trigger, which wraps its child in a clickable span).
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md';

interface BaseProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: React.ReactNode;
}

type ButtonProps =
  | (BaseProps & React.ButtonHTMLAttributes<HTMLButtonElement> & { as?: 'button' })
  | (BaseProps & React.HTMLAttributes<HTMLSpanElement> & { as: 'span' });

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-50',
  secondary:
    'border border-[var(--color-border)] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50',
  ghost:
    'text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline disabled:opacity-50',
  destructive:
    'text-red-600 dark:text-red-400 hover:underline disabled:opacity-50',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm font-medium rounded-md',
  md: 'px-4 py-2 text-sm font-medium rounded-md',
};

export function Button(props: ButtonProps): React.JSX.Element {
  const { variant = 'primary', size = 'md', className = '', children, as = 'button', ...rest } = props as BaseProps & {
    as?: 'button' | 'span';
  } & Record<string, unknown>;

  const cls = [
    'inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap',
    // Keyboard focus affordance — brand ring at 40%. Tailwind 3 can't apply an
    // opacity modifier to a var() arbitrary value (`ring-[color-mix(in_srgb,var(--x)_40%,transparent)]` emits
    // nothing), so the tint is done with color-mix instead.
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_40%,transparent)]',
    SIZES[size],
    VARIANTS[variant],
    className,
  ].join(' ');

  if (as === 'span') {
    return (
      <span className={`cursor-pointer ${cls}`} {...(rest as React.HTMLAttributes<HTMLSpanElement>)}>
        {children}
      </span>
    );
  }
  return (
    <button className={cls} {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  );
}
