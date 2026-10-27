/**
 * Pins the Application nav: Email and Settings are their own groups, Email's
 * pages are AppNav tabs, Billing is one row split into Operate and Configure,
 * Lifecycle became Settings and its old URL still lands there with its query,
 * and every section the nav offers has a scope entry.
 */

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let pathname = '/applications/app_1';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock('@/components/Link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; 'aria-current'?: string }) =>
    createElement('a', { href, 'aria-current': rest['aria-current'] }, children),
}));

import { APP_SECTION_GROUPS, SEG_SCOPE } from '../src/lib/app-sections';
import { AppNav } from '../src/components/AppNav';
import LifecycleRedirect from '../src/app/(authed)/applications/[id]/lifecycle/page';

const segs = APP_SECTION_GROUPS.flatMap((g) => g.sections.map((s) => s.seg));

describe('Application nav', () => {
  it('gives Email and Settings their own groups, outside Developer', () => {
    const developer = APP_SECTION_GROUPS.find((g) => g.key === 'developer');
    expect(developer?.sections.map((s) => s.seg)).toEqual(['api-keys', 'webhooks', 'requests', 'access']);
    expect(APP_SECTION_GROUPS.find((g) => g.key === 'email')?.sections.map((s) => s.seg)).toEqual([
      'email',
      'email/templates',
      'email/custom',
      'email/logs',
      'email/suppressions',
    ]);
    expect(APP_SECTION_GROUPS.find((g) => g.key === 'settings')?.sections.map((s) => s.seg)).toEqual(['settings']);
  });

  it('no longer offers Lifecycle, and names Access by what it holds', () => {
    expect(segs).not.toContain('lifecycle');
    const access = APP_SECTION_GROUPS.flatMap((g) => g.sections).find((s) => s.seg === 'access');
    expect(access?.label).toBe('Allowed origins & IPs');
  });

  it('declares a scope for every section it offers', () => {
    for (const seg of segs) expect(SEG_SCOPE).toHaveProperty(seg);
  });
});

function nav(path: string, billingEnabled = true): string {
  pathname = path;
  return renderToStaticMarkup(createElement(AppNav, { id: 'app_1', billingEnabled }));
}
const current = (html: string): string[] =>
  [...html.matchAll(/<a href="([^"]+)" aria-current="page"/g)].map((m) => m[1]!);

describe('AppNav second row', () => {
  it('marks the Email tab the path sits under', () => {
    expect(current(nav('/applications/app_1/email/logs'))).toContain('/applications/app_1/email/logs');
    expect(current(nav('/applications/app_1/email/custom/welcome'))).toContain('/applications/app_1/email/custom');
  });

  it('marks Templates on a per-event editor, which no tab names', () => {
    const html = nav('/applications/app_1/email/password_reset');
    expect(current(html)).toContain('/applications/app_1/email/templates');
    expect(html).not.toContain('<a href="/applications/app_1/email" aria-current="page"');
  });

  it('splits Billing with one divider before Setup and leaves Imports out', () => {
    const html = nav('/applications/app_1/payments');
    expect(html.match(/role="separator"/g)).toHaveLength(1);
    expect(html.indexOf('role="separator"')).toBeGreaterThan(html.indexOf('/billing-log"'));
    expect(html.indexOf('role="separator"')).toBeLessThan(html.indexOf('/applications/app_1/billing"'));
    expect(html).not.toContain('/applications/app_1/imports"');
  });

  it('shows Imports while you stand on it, and no divider while billing is off', () => {
    expect(nav('/applications/app_1/imports')).toContain('/applications/app_1/imports"');
    expect(nav('/applications/app_1/billing', false)).not.toContain('role="separator"');
  });
});

describe('/lifecycle', () => {
  it('redirects to Settings and keeps the query', async () => {
    await expect(
      LifecycleRedirect({
        params: Promise.resolve({ id: 'app_1' }),
        searchParams: Promise.resolve({ promoted: '1', error: ['A', 'B'] }),
      }),
    ).rejects.toThrow('NEXT_REDIRECT:/applications/app_1/settings?promoted=1&error=A&error=B');
  });

  it('redirects without a dangling question mark when there is no query', async () => {
    await expect(
      LifecycleRedirect({ params: Promise.resolve({ id: 'app_1' }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow(/NEXT_REDIRECT:\/applications\/app_1\/settings$/);
  });
});
