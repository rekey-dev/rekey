/**
 * Primary buttons: a light label on a fill dark enough to carry it in light
 * mode, and WCAG AA (4.5:1) in both themes, resting and hovered.
 *
 * Light mode used to put ink (#0a0a0a) on the brand teal, which passed AA at
 * 5.29:1 and was reported as broken, black-text buttons. White on that teal
 * was 3.74:1, which is why the label had been flipped in the first place. The
 * fix darkens the light fill instead (`globals.css` has the measurements).
 * These read the tokens straight out of the stylesheet, so a later edit that
 * brings back either failure goes red here rather than on a customer's screen.
 * The computed colours were also measured on a production build.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const css = readFileSync(path.join(srcDir, 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no ${selector} block in globals.css`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

function token(body: string, name: string): string | undefined {
  return body.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const light = block(':root');
const dark = block('.dark');
const themes = {
  light: {
    fill: token(light, 'color-primary')!,
    hover: token(light, 'color-primary-hover')!,
    label: token(light, 'color-primary-fg')!,
  },
  dark: {
    fill: token(dark, 'color-primary') ?? token(light, 'color-primary')!,
    hover: token(dark, 'color-primary-hover') ?? token(light, 'color-primary-hover')!,
    // Dark mode inherits the light label unless it sets its own, which is
    // exactly the mistake worth catching: white on the bright dark fill.
    label: token(dark, 'color-primary-fg') ?? token(light, 'color-primary-fg')!,
  },
};

describe('primary button colours', () => {
  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: label on the fill meets 4.5:1, resting and hovered`, () => {
      expect(contrast(t.label, t.fill), `${name} resting ${t.label} on ${t.fill}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.label, t.hover), `${name} hover ${t.label} on ${t.hover}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('light mode puts a light label on the fill, not black text', () => {
    expect(
      luminance(themes.light.label),
      `Light-mode primary buttons have a dark label (${themes.light.label}). Operators read black text on the brand colour as a broken button; darken --color-primary instead of flipping the label.`,
    ).toBeGreaterThan(0.5);
  });

  it('no primary fill hard-codes its label colour instead of using the token', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const full = path.join(dir, n);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(n)) {
          const src = readFileSync(full, 'utf8');
          for (const cls of src.match(/["'`][^"'`\n]*bg-\[var\(--color-primary\)\][^"'`\n]*["'`]/g) ?? []) {
            if (/\btext-(white|black|neutral-\d+)\b/.test(cls)) offenders.push(`${path.relative(srcDir, full)}: ${cls.slice(0, 90)}`);
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders, 'use text-[var(--color-primary-fg)] on a primary fill').toEqual([]);
  });
});
