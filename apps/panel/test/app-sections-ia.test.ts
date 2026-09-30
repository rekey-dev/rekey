/**
 * Pins the Application nav moves: Email and Settings are their own groups,
 * Lifecycle became Settings and its old URL still lands there with its query,
 * and every section the nav offers has a scope entry.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

import { APP_SECTION_GROUPS, SEG_SCOPE } from '../src/lib/app-sections';
import LifecycleRedirect from '../src/app/(authed)/applications/[id]/lifecycle/page';

const segs = APP_SECTION_GROUPS.flatMap((g) => g.sections.map((s) => s.seg));

describe('Application nav', () => {
  it('gives Email and Settings their own groups, outside Developer', () => {
    const developer = APP_SECTION_GROUPS.find((g) => g.key === 'developer');
    expect(developer?.sections.map((s) => s.seg)).toEqual(['api-keys', 'webhooks', 'requests', 'access']);
    expect(APP_SECTION_GROUPS.find((g) => g.key === 'email')?.sections.map((s) => s.seg)).toEqual(['email']);
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
