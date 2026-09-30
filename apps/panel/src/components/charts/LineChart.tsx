import * as React from 'react';
import { niceTicks, segments, seriesColor, tickIndexes } from '@/lib/chart-scale';
import { formatCount } from '@/lib/metric-format';
import { ChartHover } from './ChartHover';
import { ChartTable } from './ChartTable';

export interface LineSeries {
  key: string;
  label: string;
  /** One value per x label; null is a gap, drawn as a break in the line. */
  values: Array<number | null>;
  color?: string;
  /** Dashed, for the previous-period overlay. */
  dashed?: boolean;
}

const W = 1000;
const PLOT_H = 200;

/**
 * A line chart over equal x slots (days or weeks). Lines are SVG with
 * non-scaling strokes; axis text is HTML placed by percentage, so it never
 * stretches with the plot.
 *
 * @example
 * <LineChart title="Daily active users" labels={dates} series={[{ key: 'dau', label: 'DAU', values }]} axisNote="UTC" />
 */
export function LineChart({
  title,
  labels,
  series,
  heightClass = 'h-40 sm:h-52',
  axisNote,
  format = formatCount,
  yMax,
  unavailableBefore,
  unavailableLabel,
}: {
  /** What the chart shows. Becomes the accessible name and the table caption. */
  title: string;
  labels: string[];
  series: LineSeries[];
  /** Display height; 160px on a phone by default. The plot stretches to it. */
  heightClass?: string;
  /** Shown after the last x label, for the timezone ("UTC"). */
  axisNote?: string;
  format?: (n: number) => string;
  /** Fix the axis top, for rates (1 = 100%). */
  yMax?: number;
  /** Slots before this index have no data; the area is shaded and labelled. */
  unavailableBefore?: number;
  unavailableLabel?: string;
}): React.JSX.Element {
  const height = PLOT_H;
  const n = labels.length;
  const dataMax = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const { max, ticks } = yMax !== undefined ? { max: yMax, ticks: [0, yMax / 2, yMax] } : niceTicks(dataMax);
  const x = (i: number): number => (n <= 1 ? W / 2 : (i * W) / (n - 1));
  const y = (v: number): number => height - (v / max) * height;
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }));
  const shade = unavailableBefore !== undefined && unavailableBefore > 0 ? Math.min(n, unavailableBefore) : 0;

  const latest = colored.find((s) => !s.dashed);
  const lastValue = latest ? [...latest.values].reverse().find((v): v is number => v !== null) : undefined;
  const summary = `${title}, ${labels[0] ?? ''} to ${labels[n - 1] ?? ''}${
    lastValue !== undefined ? `, latest ${format(lastValue)}` : ''
  }, peak ${format(dataMax)}.`;

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
          <svg
            viewBox={`0 0 ${W} ${height}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
            role="img"
            aria-label={summary}
          >
            {shade > 0 && (
              <rect x={0} y={0} width={x(shade - 1) + (n > 1 ? W / (n - 1) / 2 : 0)} height={height} className="fill-[var(--color-surface-muted)]" />
            )}
            {ticks.map((t) => (
              <line
                key={t}
                x1={0}
                x2={W}
                y1={y(t)}
                y2={y(t)}
                className="stroke-[var(--color-border)]"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {colored.map((s) =>
              segments(s.values).map((run, k) =>
                run.length === 1 ? (
                  <circle key={`${s.key}-${k}`} cx={x(run[0]![0])} cy={y(run[0]![1])} r={2} fill={s.color} vectorEffect="non-scaling-stroke" />
                ) : (
                  <polyline
                    key={`${s.key}-${k}`}
                    points={run.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={s.dashed ? 1.5 : 2}
                    strokeDasharray={s.dashed ? '5 4' : undefined}
                    strokeOpacity={s.dashed ? 0.7 : 1}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ),
              ),
            )}
          </svg>
          {shade > 0 && unavailableLabel && (
            <span
              className="pointer-events-none absolute left-1 top-1 max-w-[45%] text-[10px] leading-tight text-[var(--color-muted-fg)]"
              style={{ maxWidth: `${Math.max(20, (shade / n) * 100)}%` }}
            >
              {unavailableLabel}
            </span>
          )}
          <ChartHover
            label={title}
            points={labels.map((l, i) => ({
              label: l,
              rows: colored.map((s) => ({
                name: s.label,
                value: s.values[i] === null || s.values[i] === undefined ? 'no data' : format(s.values[i]!),
                color: s.color,
                ...(s.dashed ? { dashed: true } : {}),
              })),
            }))}
          />
        </div>
      </div>
      <XAxis labels={labels} note={axisNote} />
      {colored.length > 1 && <Legend items={colored.map((s) => ({ label: s.label, color: s.color, dashed: s.dashed ?? false }))} />}
      <ChartTable
        caption={title}
        columns={['Date', ...colored.map((s) => s.label)]}
        rows={labels.map((l, i) => [l, ...colored.map((s) => (s.values[i] == null ? 'no data' : format(s.values[i]!)))])}
      />
    </figure>
  );
}

/** Three ticks on a phone, up to five from `sm` up, always the first and last, never two side by side. */
export function XAxis({
  labels,
  note,
  band = false,
}: {
  labels: string[];
  note?: string | undefined;
  /** Labels sit under the middle of each slot (bars) rather than on the points (lines). */
  band?: boolean;
}): React.JSX.Element {
  const n = labels.length;
  const room = Math.max(2, Math.ceil(n / 2));
  const wide = new Set(tickIndexes(n, Math.min(5, room)));
  const narrow = new Set(tickIndexes(n, Math.min(3, room)));
  return (
    <>
    <div className="relative ml-11 mt-1 h-4 text-[10px] tabular-nums text-[var(--color-muted-fg)]" aria-hidden="true">
      {labels.map((l, i) => {
        if (!wide.has(i)) return null;
        const pos = band ? ((i + 0.5) / n) * 100 : n <= 1 ? 50 : (i / (n - 1)) * 100;
        const align = i === 0 ? 'translate-x-0' : i === n - 1 ? '-translate-x-full' : '-translate-x-1/2';
        return (
          <span
            key={i}
            className={`absolute whitespace-nowrap ${align} ${narrow.has(i) ? '' : 'hidden sm:inline'}`}
            style={{ left: `${pos}%` }}
          >
            {shortDate(l)}
          </span>
        );
      })}
    </div>
    {note && <p className="ml-11 text-right text-[10px] text-[var(--color-faint-fg)]">{note} days</p>}
    </>
  );
}

/** "2026-09-29" as "Sep 29"; anything else as given. */
export function shortDate(label: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (!m) return label;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function Legend({
  items,
}: {
  items: Array<{ label: string; color: string; dashed?: boolean; square?: boolean }>;
}): React.JSX.Element {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted-fg)]">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          {it.square ? (
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: it.color }} />
          ) : (
            <span
              aria-hidden="true"
              className="inline-block h-0 w-3.5"
              style={{ borderTop: `2px ${it.dashed ? 'dashed' : 'solid'} ${it.color}` }}
            />
          )}
          {it.label}
        </li>
      ))}
    </ul>
  );
}
