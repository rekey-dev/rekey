/**
 * The hand-rolled chart primitives. Rendered to markup, because what matters
 * is in the output: every chart states its data as text (an accessible name
 * and a table, or a list), a gap is a gap rather than a zero, and nothing
 * divides by zero on an empty application.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { niceTicks, segments, tickIndexes } from '@/lib/chart-scale';
import { formatCount, formatPoints, formatShare } from '@/lib/metric-format';
import { LineChart, XAxis, shortDate } from '@/components/charts/LineChart';
import { StackedBars } from '@/components/charts/StackedBars';
import { BarList } from '@/components/charts/BarList';
import { Funnel } from '@/components/charts/Funnel';
import { RetentionGrid } from '@/components/charts/RetentionGrid';
import { Sparkline } from '@/components/charts/Sparkline';

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);
const days = ['2026-09-27', '2026-09-28', '2026-09-29'];

describe('scales and formats', () => {
  it('picks a round axis top on a 1-2-5 step', () => {
    expect(niceTicks(87)).toEqual({ max: 100, ticks: [0, 50, 100] });
    expect(niceTicks(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceTicks(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceTicks(1234).max).toBeGreaterThanOrEqual(1234);
  });

  it('splits a series at gaps instead of dropping to zero', () => {
    expect(segments([1, 2, null, 4, undefined, 6, 7])).toEqual([
      [
        [0, 1],
        [1, 2],
      ],
      [[3, 4]],
      [
        [5, 6],
        [6, 7],
      ],
    ]);
  });

  it('always ticks the first and last label', () => {
    expect(tickIndexes(30, 3)).toEqual([0, 15, 29]);
    expect(tickIndexes(2, 5)).toEqual([0, 1]);
    expect(tickIndexes(0, 3)).toEqual([]);
  });

  it('formats counts exactly below 10,000 and compactly above', () => {
    expect(formatCount(9999)).toBe('9,999');
    expect(formatCount(48210)).toBe('48.2K');
    expect(formatShare(0.2173)).toBe('21.7%');
    expect(formatPoints(0.003)).toBe('+0.3 pt');
    expect(formatPoints(-0.012)).toBe('−1.2 pt');
    expect(formatPoints(0)).toBe('±0.0 pt');
  });

  it('shortens ISO dates in UTC', () => {
    expect(shortDate('2026-09-01')).toBe('Sep 1');
    expect(shortDate('week 3')).toBe('week 3');
  });
});

describe('LineChart', () => {
  const html = render(
    createElement(LineChart, {
      title: 'Daily active users',
      labels: days,
      axisNote: 'UTC',
      series: [
        { key: 'dau', label: 'DAU', values: [3, null, 5] },
        { key: 'prev', label: 'Previous period', values: [2, 2, 2], dashed: true },
      ],
    }),
  );

  it('has an accessible summary and a data table', () => {
    expect(html).toMatch(/role="img" aria-label="Daily active users, 2026-09-27 to 2026-09-29, latest 5, peak 5\."/);
    expect(html).toContain('<caption class="sr-only">Daily active users</caption>');
    expect(text(html)).toContain('View as table');
    expect(text(html)).toContain('2026-09-28 no data 2');
  });

  it('breaks the line at a gap and dashes the previous period', () => {
    expect(html.match(/<circle/g)?.length).toBe(2);
    expect(html).toContain('stroke-dasharray="5 4"');
  });

  it('names the timezone on the axis', () => {
    expect(text(html)).toContain('Sep 29 UTC days');
  });

  it('shades and labels the part of the range with no data', () => {
    const shaded = render(
      createElement(LineChart, {
        title: 'DAU',
        labels: days,
        series: [{ key: 'dau', label: 'DAU', values: [null, 1, 2] }],
        unavailableBefore: 1,
        unavailableLabel: 'No activity data before Sep 28',
      }),
    );
    expect(text(shaded)).toContain('No activity data before Sep 28');
    expect(shaded).toContain('fill-[var(--color-surface-muted)]');
  });

  it('survives an empty series', () => {
    expect(() => render(createElement(LineChart, { title: 'Empty', labels: [], series: [] }))).not.toThrow();
  });
});

describe('XAxis', () => {
  it('never puts two ticks side by side on a short series', () => {
    const labels = Array.from({ length: 7 }, (_, i) => `2026-09-${String(23 + i).padStart(2, '0')}`);
    const t = text(render(createElement(XAxis, { labels, band: true })));
    expect(t).toBe('Sep 23 Sep 25 Sep 27 Sep 29');
  });
});

describe('StackedBars', () => {
  it('stacks series, totals them in the table, and carries the line', () => {
    const html = render(
      createElement(StackedBars, {
        title: 'Sign-ins by method',
        labels: days,
        series: [
          { key: 'password', label: 'Password', values: [1, 2, 0] },
          { key: 'passkey', label: 'Passkey', values: [3, 0, 1] },
        ],
        line: { label: 'Running total', values: [4, 6, 7] },
      }),
    );
    expect(html).toContain('aria-label="Sign-ins by method, 2026-09-27 to 2026-09-29, 7 in total, busiest day 4."');
    expect(text(html)).toContain('Date Password Passkey Total Running total');
    expect(text(html)).toContain('2026-09-27 1 3 4 4');
    // A zero draws no rect: four non-zero cells.
    expect(html.match(/<rect/g)?.length).toBe(4);
  });
});

describe('BarList', () => {
  it('lists the top items, then Other and Unknown, with shares', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, label: `Item ${i}`, count: 10 - i, share: (10 - i) / 100 }));
    const html = render(
      createElement(BarList, { title: 'Country', items, unknown: { count: 7, share: 0.07 }, limit: 8 }),
    );
    const t = text(html);
    expect(t).toContain('Item 7');
    expect(t).not.toContain('Item 8');
    expect(t).toContain('Other 3 3.0%');
    expect(t).toContain('Unknown 7 7.0%');
    expect(html).toContain('aria-label="Country"');
  });

  it('says a suppressed cell is small instead of printing a number', () => {
    const html = render(
      createElement(BarList, { title: 'Country', items: [{ key: 'IS', label: 'IS', count: null, share: null }] }),
    );
    expect(text(html)).toContain('fewer than 5');
  });
});

describe('Funnel', () => {
  it('shows step and overall conversion, and a side branch', () => {
    const html = render(
      createElement(Funnel, {
        title: 'Onboarding',
        steps: [
          { key: 'created', label: 'Created', count: 200 },
          { key: 'verified', label: 'Verified', count: 150 },
          { key: 'completed', label: 'Completed', count: 75, branch: { label: 'Skipped', count: 20 } },
        ],
      }),
    );
    const t = text(html);
    expect(t).toContain('Verified 150 75.0% of previous 75.0% of all');
    expect(t).toContain('Completed 75 50.0% of previous 37.5% of all');
    expect(t).toContain('Skipped: 20 (10.0% of all)');
  });

  it('leaves out a share of the previous step over 100%', () => {
    const t = text(render(createElement(Funnel, { title: 'x', steps: [{ key: 'a', label: 'Verified', count: 10 }, { key: 'b', label: 'Signed in', count: 17 }] })));
    expect(t).toContain('Signed in 17 170.0% of all');
    expect(t).not.toContain('of previous');
  });

  it('does not divide by zero on an empty cohort', () => {
    const html = render(createElement(Funnel, { title: 'x', steps: [{ key: 'a', label: 'A', count: 0 }, { key: 'b', label: 'B', count: 0 }] }));
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });
});

describe('RetentionGrid', () => {
  it('is a real table with a blank for weeks that have not happened', () => {
    const html = render(
      createElement(RetentionGrid, {
        title: 'Weekly retention',
        weeks: 3,
        cohorts: [
          { week: '2026-09-14', size: 40, retained: [1, 0.425, 0.3] },
          { week: '2026-09-21', size: 12, retained: [1, 0.5, null] },
        ],
      }),
    );
    expect(html).toContain('<caption class="sr-only">Weekly retention.');
    const t = text(html);
    expect(t).toContain('Sep 14 40 100% 42.5% 30%');
    expect(t).toContain('Sep 21 12 100% 50% no data');
  });
});

describe('Sparkline', () => {
  it('is decorative and scales to its box', () => {
    const html = render(createElement(Sparkline, { data: [1, 2, 3] }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('preserveAspectRatio="none"');
    expect(html.match(/<rect/g)?.length).toBe(3);
  });
});
