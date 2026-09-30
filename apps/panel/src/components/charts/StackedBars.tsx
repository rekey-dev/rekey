import * as React from 'react';
import { niceTicks, seriesColor } from '@/lib/chart-scale';
import { formatCount } from '@/lib/metric-format';
import { ChartHover } from './ChartHover';
import { ChartTable } from './ChartTable';
import { Legend, XAxis } from './LineChart';

export interface BarSeries {
  key: string;
  label: string;
  values: number[];
  color?: string;
}

const W = 1000;
const PLOT_H = 180;

/**
 * Stacked columns over equal x slots, with an optional line on its own scale
 * (a running total beside daily counts). One series is a plain bar chart.
 *
 * @example
 * <StackedBars title="Sign-ins by method" labels={dates} series={[{ key: 'password', label: 'Password', values }]} />
 */
export function StackedBars({
  title,
  labels,
  series,
  line,
  heightClass = 'h-40 sm:h-44',
  axisNote,
  format = formatCount,
}: {
  title: string;
  labels: string[];
  series: BarSeries[];
  /** Drawn over the bars on its own scale; its values are in the hover and the table. */
  line?: { label: string; values: number[] };
  /** Display height; the plot stretches to it. */
  heightClass?: string;
  axisNote?: string;
  format?: (n: number) => string;
}): React.JSX.Element {
  const height = PLOT_H;
  const n = labels.length;
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }));
  const totals = labels.map((_, i) => colored.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const { max, ticks } = niceTicks(Math.max(0, ...totals));
  const lineMax = line ? Math.max(1, ...line.values) : 1;
  const slot = n === 0 ? W : W / n;
  const bar = Math.max(1, slot * 0.72);
  const lineColor = 'var(--color-fg)';

  const summary = `${title}, ${labels[0] ?? ''} to ${labels[n - 1] ?? ''}, ${format(
    totals.reduce((a, b) => a + b, 0),
  )} in total, busiest day ${format(Math.max(0, ...totals))}.`;

  return (
    <figure className="m-0">
      <div className="flex gap-2">
        <div className={`relative w-9 shrink-0 text-right text-[10px] tabular-nums text-[var(--color-muted-fg)] ${heightClass}`} aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2 leading-none" style={{ top: `${(1 - t / max) * 100}%` }}>
              {format(t)}
            </span>
          ))}
        </div>
        <div className={`relative min-w-0 flex-1 ${heightClass}`}>
          <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" role="img" aria-label={summary}>
            {ticks.map((t) => (
              <line
                key={t}
                x1={0}
                x2={W}
                y1={height - (t / max) * height}
                y2={height - (t / max) * height}
                className="stroke-[var(--color-border)]"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {labels.map((_, i) => {
              let base = height;
              return colored.map((s) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                const h = (v / max) * height;
                base -= h;
                return <rect key={`${s.key}-${i}`} x={i * slot + (slot - bar) / 2} y={base} width={bar} height={h} fill={s.color} />;
              });
            })}
            {line && n > 0 && (
              <polyline
                points={line.values.map((v, i) => `${(i * slot + slot / 2).toFixed(1)},${(height - (v / lineMax) * height).toFixed(1)}`).join(' ')}
                fill="none"
                stroke={lineColor}
                strokeWidth={1.5}
                strokeOpacity={0.6}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          <ChartHover
            label={title}
            points={labels.map((l, i) => ({
              label: l,
              rows: [
                ...colored.map((s) => ({ name: s.label, value: format(s.values[i] ?? 0), color: s.color })),
                ...(colored.length > 1 ? [{ name: 'Total', value: format(totals[i] ?? 0), color: 'transparent' }] : []),
                ...(line ? [{ name: line.label, value: format(line.values[i] ?? 0), color: lineColor }] : []),
              ],
            }))}
          />
        </div>
      </div>
      <XAxis labels={labels} note={axisNote} band />
      {(colored.length > 1 || line) && (
        <Legend
          items={[
            ...colored.map((s) => ({ label: s.label, color: s.color, square: true })),
            ...(line ? [{ label: line.label, color: lineColor }] : []),
          ]}
        />
      )}
      <ChartTable
        caption={title}
        columns={['Date', ...colored.map((s) => s.label), ...(colored.length > 1 ? ['Total'] : []), ...(line ? [line.label] : [])]}
        rows={labels.map((l, i) => [
          l,
          ...colored.map((s) => format(s.values[i] ?? 0)),
          ...(colored.length > 1 ? [format(totals[i] ?? 0)] : []),
          ...(line ? [format(line.values[i] ?? 0)] : []),
        ])}
      />
    </figure>
  );
}
