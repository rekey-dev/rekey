import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { errorMessage, GENERIC_ERROR_MESSAGE } from '@/lib/error-message';
import { SUPPORT_ERR, SupportFeedback } from '@/app/(authed)/applications/[id]/end-users/[euid]/support-feedback';
import { PlanCreateForm } from '@/components/PlanCreateForm';

/**
 * Error banners look their `?error=` code up in a message map. The fallback
 * used to be the code itself, so a crafted link put any sentence it liked into
 * a real error banner on the real panel host.
 */

const CRAFTED = 'Your account is suspended. Call +1 555 0100 to restore access';

const MESSAGES: Record<string, string> = {
  RATE_LIMITED: 'Too many sends in a short window.',
};

describe('errorMessage', () => {
  it('renders the page copy for a code it knows, unchanged', () => {
    expect(errorMessage(MESSAGES, 'RATE_LIMITED')).toBe('Too many sends in a short window.');
  });

  it('renders the generic sentence for an unknown code, never the code', () => {
    for (const code of [CRAFTED, 'SOME_FUTURE_CODE', '']) {
      expect(errorMessage(MESSAGES, code)).toBe(GENERIC_ERROR_MESSAGE);
    }
  });

  it('never reaches an inherited Object property', () => {
    expect(errorMessage(MESSAGES, 'constructor')).toBe(GENERIC_ERROR_MESSAGE);
    expect(errorMessage(MESSAGES, 'toString')).toBe(GENERIC_ERROR_MESSAGE);
  });
});

describe('banners rendering a URL error code', () => {
  it('SupportFeedback shows mapped copy for a known code', () => {
    const html = renderToStaticMarkup(createElement(SupportFeedback, { error: 'RATE_LIMITED' }));
    expect(html).toContain(SUPPORT_ERR.RATE_LIMITED);
  });

  it('SupportFeedback shows the generic sentence for an unknown code, not the raw value', () => {
    const html = renderToStaticMarkup(createElement(SupportFeedback, { error: CRAFTED }));
    expect(html).toContain(GENERIC_ERROR_MESSAGE);
    expect(html).not.toContain('suspended');
  });

  it('PlanCreateForm shows the generic sentence for an unknown code, not the raw value', () => {
    const html = renderToStaticMarkup(
      createElement(PlanCreateForm, { action: async () => undefined, meters: [], error: CRAFTED }),
    );
    expect(html).toContain(GENERIC_ERROR_MESSAGE);
    expect(html).not.toContain('suspended');
  });

  it('no component falls back to the looked-up code itself', () => {
    // `MAP[code] ?? code`, the shape every affected page shared. Most of those
    // pages are async server components that fetch before rendering, so they
    // are held to the helper by source rather than by render.
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) {
          const text = readFileSync(path, 'utf8');
          for (const m of text.matchAll(/\b[A-Z_]+\[([A-Za-z_]\w*)\] \?\? \1\b/g)) {
            offenders.push(`${path}: ${m[0]}`);
          }
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
