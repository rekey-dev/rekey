'use client';

import * as React from 'react';

type Edges = { start: boolean; end: boolean };

function edgesOf(el: HTMLElement): Edges {
  const max = el.scrollWidth - el.clientWidth;
  return { start: el.scrollLeft > 1, end: max - el.scrollLeft > 1 };
}

/**
 * Horizontal scroll container for a table, with a fade on whichever edge has
 * more columns behind it. On a phone a wide table used to end mid-column with
 * nothing saying the rest was a swipe away.
 *
 * @example
 * <TableScroller className="rounded-xl border"><table>…</table></TableScroller>
 */
export function TableScroller({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState<Edges>({ start: false, end: false });

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => {
      const next = edgesOf(el);
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    const table = el.firstElementChild;
    if (table) observer.observe(table);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  const fade =
    'pointer-events-none absolute inset-y-0 z-20 w-10 transition-opacity duration-150 ease-out';
  return (
    <div className={`relative ${className}`}>
      <div ref={ref} className="overflow-x-auto rounded-[inherit]">
        {children}
      </div>
      <div
        aria-hidden="true"
        className={`${fade} left-0 rounded-l-[inherit] bg-gradient-to-r from-[var(--color-surface)] to-transparent ${edges.start ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        aria-hidden="true"
        className={`${fade} right-0 rounded-r-[inherit] bg-gradient-to-l from-[var(--color-surface)] to-transparent ${edges.end ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
}
