import type { AnalyticsBreakdown } from '@rekey.dev/shared-types';

export const TOP_ROWS = 8;

/**
 * Grouped counts as the top `top` keys by count, the rest summed as `other`,
 * and rows with no value as `unknown`. Shares are of the whole total.
 *
 * @example
 *   breakdown([{ key: 'web', n: 3 }, { key: null, n: 1 }]) // rows [{key:'web',count:3,share:0.75}], unknown 1
 */
export function breakdown(groups: Array<{ key: string | null; n: number | bigint }>, top = TOP_ROWS): AnalyticsBreakdown {
  const known = groups
    .filter((g) => g.key !== null && g.key !== '')
    .map((g) => ({ key: g.key as string, count: Number(g.n) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const unknown = groups.filter((g) => g.key === null || g.key === '').reduce((s, g) => s + Number(g.n), 0);
  const total = known.reduce((s, g) => s + g.count, 0) + unknown;
  const share = (n: number): number => (total === 0 ? 0 : n / total);
  const head = known.slice(0, top);
  const other = known.slice(top).reduce((s, g) => s + g.count, 0);
  return { rows: head.map((g) => ({ ...g, share: share(g.count) })), other, unknown, total };
}
