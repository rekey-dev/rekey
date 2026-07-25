/**
 * Section shell — the standard portal card used to group dashboard content.
 * Replaces the hand-rolled `rounded-xl border … p-5` string repeated across
 * [slug]/page.tsx. Defaults to <section> since every current usage is one.
 */

import type { ReactNode } from 'react';

type CardElement = 'div' | 'section' | 'li' | 'article';

export function Card({
  children,
  className = '',
  as = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: CardElement;
}): ReactNode {
  const Tag = as;
  return (
    <Tag
      className={[
        'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </Tag>
  );
}
