/**
 * Pure helpers the hand-rolled charts share: nice axis ticks, the series
 * palette, and splitting a series with gaps into drawable runs. No DOM, so
 * they are unit-tested directly.
 */

/** The categorical palette, in order. Index 6 onwards wraps; "other" is separate. */
export const SERIES_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
] as const;
export const OTHER_COLOR = 'var(--chart-other)';

export function seriesColor(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length]!;
}

/**
 * A rounded axis maximum and evenly spaced ticks from 0 to it, on a 1, 2, 5
 * step. A series of all zeros still gets an axis (0 to 1).
 *
 * @example
 * niceTicks(87) // { max: 100, ticks: [0, 50, 100] }
 */
export function niceTicks(dataMax: number, count = 4): { max: number; ticks: number[] } {
  const top = Math.max(1, dataMax);
  const rough = top / count;
  let step = 1;
  if (rough > 1) {
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  }
  const max = Math.ceil(top / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  return { max, ticks };
}

/**
 * Consecutive non-null runs of a series, as `[index, value]` pairs, so a line
 * breaks at a gap instead of dropping to zero across it.
 */
export function segments(values: ReadonlyArray<number | null | undefined>): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v === null || v === undefined || Number.isNaN(v)) {
      if (run.length) out.push(run);
      run = [];
    } else {
      run.push([i, v]);
    }
  });
  if (run.length) out.push(run);
  return out;
}

/** Evenly spread tick indexes over `n` labels, always including the first and last. */
export function tickIndexes(n: number, count: number): number[] {
  if (n <= 0) return [];
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < count; i++) out.add(Math.round((i * (n - 1)) / (count - 1)));
  return [...out];
}
