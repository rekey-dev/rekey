/**
 * The Portal page used to show `<set NEXT_PUBLIC_PORTAL_URL>/<slug>` under
 * "Portal is live" when nothing configured a portal. The API now reports the
 * portal origin it actually serves, and no value means no portal URL at all.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { portalBase } from '@/lib/portal-base';

const page = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'app',
    '(authed)',
    'applications',
    '[id]',
    'portal',
    'page.tsx',
  ),
  'utf8',
);

describe('portalBase', () => {
  it("is the API's value, without a trailing slash", () => {
    expect(portalBase({ portalBaseUrl: 'https://portal.api.example/' })).toBe('https://portal.api.example');
  });

  it('is null when the deployment runs no portal, and for a row that carries no value', () => {
    expect(portalBase({ portalBaseUrl: null })).toBeNull();
    expect(portalBase({})).toBeNull();
  });

  it('never produces a placeholder the page could show as live', () => {
    expect(page).not.toMatch(/<set [A-Z_]+>/);
    expect(page).toContain('portalBase(app)');
  });
});
