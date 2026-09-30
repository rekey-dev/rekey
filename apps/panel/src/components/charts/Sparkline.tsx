import * as React from 'react';

/**
 * A bar sparkline that scales to its container's width, so a long series
 * never spills past the tile it sits in. Decorative: the tile states the
 * number, so the chart is hidden from assistive technology.
 *
 * @example
 * <Sparkline data={[1, 4, 2, 6]} />
 */
export function Sparkline({ data, height = 32 }: { data: number[]; height?: number }): React.JSX.Element {
  const n = Math.max(1, data.length);
  const max = Math.max(1, ...data);
  const slot = 100 / n;
  const bar = slot * 0.7;
  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className="block w-full"
      style={{ height }}
      aria-hidden="true"
      focusable="false"
    >
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * height);
        return (
          <rect
            key={i}
            x={i * slot + (slot - bar) / 2}
            y={height - h}
            width={bar}
            height={h}
            rx={0.6}
            className="fill-[color-mix(in_srgb,var(--color-primary)_55%,transparent)] transition-colors group-hover:fill-[var(--color-primary)]"
          />
        );
      })}
    </svg>
  );
}
