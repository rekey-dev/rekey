/**
 * The reporting timezone control on Settings: an editor for callers who may
 * save it (write access and `overview:write`), the plain value for everyone
 * else, never a form that is certain to be refused.
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  useRouter: () => ({ refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/api', () => ({ api: async () => ({}), errorQuery: async () => '', PanelApiError: Error }));

async function render(canWrite: boolean): Promise<string> {
  const { ReportingTimezone } = await import('@/app/(authed)/applications/[id]/settings/reporting-timezone');
  return renderToStaticMarkup(createElement(ReportingTimezone, { applicationId: 'app_1', current: 'Europe/Berlin', canWrite }));
}

describe('ReportingTimezone', () => {
  it('offers every zone, the current one selected, to a caller who may save', async () => {
    const html = await render(true);
    expect(html).toContain('name="reportingTimezone"');
    expect(html).toMatch(/<option value="Europe\/Berlin" selected="">/);
    expect(html).toContain('<option value="UTC">UTC</option>');
  });

  it('lists zones by their current names', async () => {
    const { timezoneOptions } = await import('@/app/(authed)/applications/[id]/settings/reporting-timezone');
    const zones = timezoneOptions('UTC');
    expect(zones[0]).toBe('UTC');
    expect(zones).toContain('Asia/Kolkata');
    expect(zones).toContain('Europe/Kyiv');
    expect(zones).not.toContain('Asia/Calcutta');
    expect(zones.filter((z) => z === 'UTC')).toHaveLength(1);
  });

  it('shows the value and why it is read-only to anyone else', async () => {
    const html = await render(false);
    expect(html).not.toContain('<select');
    expect(html).toContain('Europe/Berlin');
    expect(html).toContain('needs write access with the Overview scope');
  });
});
