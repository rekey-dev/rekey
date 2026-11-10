/**
 * The portal pages' shared look: one keyboard focus outline, a loading
 * skeleton that belongs to the dashboard alone, motion that stops for a
 * visitor who asked for less, and a dark theme only an unbranded portal gets.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DashboardLoading from '@/app/(portal)/[slug]/(overview)/loading';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const globals = readFileSync(join(SRC, 'app/(portal)/globals.css'), 'utf8');

function portalSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'checkout' || name === '(checkout)' ? [] : portalSources(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

describe('the portal theme', () => {
  it('draws a solid focus outline on every interactive element, with nothing turning it off', () => {
    expect(globals).toMatch(/a:focus-visible,\s*button:focus-visible,[\s\S]*select:focus-visible[\s\S]*\{\s*outline: var\(--rk-focus-width\) solid var\(--color-primary\);/);
    for (const file of portalSources(SRC)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/focus-visible:(outline-none|ring)/);
    }
  });

  it('shows the loading skeleton on the dashboard only, marked busy', () => {
    expect(existsSync(join(SRC, 'app/(portal)/[slug]/loading.tsx'))).toBe(false);
    const html = renderToStaticMarkup(<DashboardLoading />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
  });

  it('stops pulsing for a visitor who prefers reduced motion', () => {
    expect(globals).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.animate-pulse\s*\{\s*animation: none;/);
  });

  it('keeps the light tokens wherever the operator chose a colour', () => {
    const [light, dark] = globals.split('@media (prefers-color-scheme: dark)');
    expect(light).toMatch(/:root,\s*\[data-scheme='light'\]\s*\{\s*color-scheme: light;/);
    expect(dark).toMatch(/^\s*\{\s*:root\s*\{\s*color-scheme: dark;/);
  });
});
