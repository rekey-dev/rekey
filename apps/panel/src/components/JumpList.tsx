'use client';

import * as React from 'react';

export interface JumpItem {
  /** In-page anchor, e.g. `#passwords`. */
  href: `#${string}`;
  label: string;
}

/**
 * A sticky row of in-page links for a long settings page, marking the section
 * currently in view. Plain anchors, so it works before hydration and the
 * browser handles focus and history.
 *
 * @example
 * <JumpList items={[{ href: '#sign-in', label: 'Sign-in methods' }]} />
 */
export function JumpList({ items }: { items: JumpItem[] }): React.JSX.Element {
  const [active, setActive] = React.useState<string | null>(null);
  const rowRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const sections = items
      .map((i) => document.getElementById(i.href.slice(1)))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        const first = sections.find((s) => visible.has(s.id));
        if (first) setActive(`#${first.id}`);
      },
      { rootMargin: '-120px 0px -55% 0px' },
    );
    for (const s of sections) observer.observe(s);
    return () => observer.disconnect();
  }, [items]);

  React.useEffect(() => {
    const link = rowRef.current?.querySelector<HTMLElement>('[aria-current="location"]');
    link?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  return (
    <nav
      ref={rowRef}
      aria-label="On this page"
      className="sticky top-12 z-30 md:top-0 -mx-1 overflow-x-auto border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_92%,transparent)] px-1 backdrop-blur [scrollbar-width:none]"
    >
      <ul className="flex gap-1 py-2">
        {items.map((item) => {
          const current = active === item.href;
          return (
            <li key={item.href} className="shrink-0">
              <a
                href={item.href}
                aria-current={current ? 'location' : undefined}
                className={`block whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
                  current
                    ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                    : 'text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]'
                }`}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
