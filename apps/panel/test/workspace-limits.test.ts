/**
 * The workspace usage-and-limits card, across the shapes a real deployment
 * actually produces.
 *
 * The bug this file exists to prevent is a single confusion: reading an ABSENT
 * ceiling as `0`. Unset is the default for every workspace and the permanent
 * state of every self-host that never touches the feature, so getting it wrong
 * does not produce a rare edge case — it tells the most common configuration
 * there is that it is completely full.
 *
 * Rendered rather than unit-tested around, because every failure mode here is
 * in the output: a meter that divides by zero, a number that says "0" when it
 * means "unlimited", a bar so thin it reads as empty. `createElement` instead
 * of JSX so the file stays `.ts`, matching the sibling tests and the `include`
 * glob in vitest.config.ts.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceLimits } from '@/components/WorkspaceLimits';
import type { WorkspaceLimitsDto } from '@/lib/api';

function render(data: WorkspaceLimitsDto): string {
  return renderToStaticMarkup(createElement(WorkspaceLimits, { data }));
}

/** Every `width:` the meters declare, in document order. */
function meterWidths(html: string): string[] {
  return [...html.matchAll(/width:\s*([^"';]+)/g)].map((m) => m[1].trim());
}

/** Visible text with tags flattened, for phrase assertions. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('WorkspaceLimits', () => {
  describe('no ceilings configured — the default, and the one that must not read as full', () => {
    it('renders "no limit" and NO meter when limits is an empty object', () => {
      const html = render({
        limits: {},
        usage: { productionApps: 3, activeEndUsers: 12842 },
      });
      expect(text(html)).toContain('no limit');
      expect(text(html)).toContain('sets no ceilings');
      // A meter at all would imply a ceiling to fill.
      expect(meterWidths(html)).toEqual([]);
      // The usage numbers are still shown — unlimited is not unknown.
      expect(text(html)).toContain('12,842');
    });

    it('treats an explicit null the same as an absent key', () => {
      const html = render({
        limits: { maxProductionApps: null, maxActiveEndUsers: null },
        usage: { productionApps: 1, activeEndUsers: 4 },
      });
      expect(text(html)).toContain('no limit');
      expect(meterWidths(html)).toEqual([]);
    });
  });

  it('handles one ceiling set and the other not — the rows are independent', () => {
    const html = render({
      limits: { maxProductionApps: 3 },
      usage: { productionApps: 1, activeEndUsers: 900 },
    });
    expect(text(html)).toContain('1 of 3');
    expect(text(html)).toContain('no limit');
    // Exactly one meter: the capped row has one, the uncapped row does not.
    expect(meterWidths(html)).toHaveLength(1);
  });

  it('does not divide by zero on a ceiling of 0, which is a legal configuration', () => {
    const html = render({
      limits: { maxProductionApps: 0, maxActiveEndUsers: 0 },
      usage: { productionApps: 0, activeEndUsers: 0 },
    });
    // The specific failure: `used / max` with max 0 is NaN, which React
    // renders into the style attribute and the browser then drops, leaving a
    // meter that silently never paints.
    expect(html).not.toContain('NaN');
    expect(meterWidths(html)).toEqual(['100%', '100%']);
  });

  it('keeps one used slot visible against a very large ceiling', () => {
    const html = render({
      limits: { maxProductionApps: 1_000_000, maxActiveEndUsers: 250_000_000 },
      usage: { productionApps: 1, activeEndUsers: 3 },
    });
    // 1 of 1,000,000 is 0.0001% — a bar that paints nothing and reads as "zero
    // used" when it is not. Floored so it stays visible.
    for (const w of meterWidths(html)) {
      expect(Number.parseFloat(w)).toBeGreaterThanOrEqual(1.5);
    }
    // Large numbers are grouped, not run together.
    expect(text(html)).toContain('1,000,000');
    expect(text(html)).toContain('250,000,000');
  });

  it('never renders a bar past 100%, even when usage is over the ceiling', () => {
    // Reachable for real: a super-admin can lower a ceiling below current
    // usage, which is explicitly allowed and strands nobody.
    const html = render({
      limits: { maxProductionApps: 1, maxActiveEndUsers: 10 },
      usage: { productionApps: 4, activeEndUsers: 500 },
    });
    for (const w of meterWidths(html)) {
      expect(Number.parseFloat(w)).toBeLessThanOrEqual(100);
    }
    expect(text(html)).toContain('4 of 1');
  });

  it('states that limits are not self-serve only when there are limits', () => {
    const capped = render({
      limits: { maxProductionApps: 2 },
      usage: { productionApps: 1, activeEndUsers: 0 },
    });
    expect(text(capped)).toContain('cannot be changed from the panel');

    const uncapped = render({ limits: {}, usage: { productionApps: 1, activeEndUsers: 0 } });
    // Telling an unlimited workspace it cannot raise a limit it does not have
    // is noise, and implies a constraint that is not there.
    expect(text(uncapped)).not.toContain('cannot be changed from the panel');
  });
});
