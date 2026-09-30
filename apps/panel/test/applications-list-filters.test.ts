/**
 * The Applications list keeps its filters in the URL. These are the rules that
 * make a filtered view shareable and keep the plain URL plain.
 */

import { describe, expect, it } from 'vitest';
import {
  appListApiQuery,
  appListHref,
  isFiltered,
  readAppListFilters,
} from '@/app/(authed)/applications/filters';
import { formatActiveDay } from '@/app/(authed)/applications/summary';

describe('Applications list filters', () => {
  it('hides disabled applications unless the URL asks for them', () => {
    expect(readAppListFilters({}).showDisabled).toBe(false);
    expect(readAppListFilters({ disabled: '1' }).showDisabled).toBe(true);
    expect(readAppListFilters({ disabled: 'true' }).showDisabled).toBe(false);
  });

  it('ignores values it does not know instead of forwarding them', () => {
    const f = readAppListFilters({ env: 'prod', sort: 'users', q: ['a', 'b'] });
    expect(f).toEqual({ q: '', environment: undefined, sort: 'created', showDisabled: false });
    expect(readAppListFilters({ env: 'production' }).environment).toBe('PRODUCTION');
  });

  it('round-trips through the URL and leaves defaults out', () => {
    const f = readAppListFilters({ q: ' web ', env: 'DEVELOPMENT', sort: 'activity', disabled: '1' });
    const href = appListHref(f);
    expect(href).toBe('/applications?q=web&env=DEVELOPMENT&sort=activity&disabled=1');
    const back = readAppListFilters(Object.fromEntries(new URL(href, 'http://x').searchParams));
    expect(back).toEqual(f);
    expect(appListHref(readAppListFilters({}))).toBe('/applications');
  });

  it('changes one field and keeps the rest', () => {
    const f = readAppListFilters({ q: 'north', env: 'PRODUCTION' });
    expect(appListHref(f, { environment: undefined })).toBe('/applications?q=north');
    expect(appListHref(f, { showDisabled: true })).toBe('/applications?q=north&env=PRODUCTION&disabled=1');
  });

  it('counts only search and environment as filters, not sort or the disabled toggle', () => {
    expect(isFiltered(readAppListFilters({ sort: 'name', disabled: '1' }))).toBe(false);
    expect(isFiltered(readAppListFilters({ q: 'x' }))).toBe(true);
    expect(isFiltered(readAppListFilters({ env: 'STAGING' }))).toBe(true);
  });

  it('asks the API for running applications only by default', () => {
    const f = readAppListFilters({ q: 'a b', env: 'PRODUCTION' });
    expect(appListApiQuery(f, { limit: 25, offset: 0 }, 'active')).toBe(
      'limit=25&offset=0&sort=created&status=active&environment=PRODUCTION&q=a+b',
    );
    expect(appListApiQuery(readAppListFilters({}), { limit: 25, offset: 50 }, undefined)).toBe(
      'limit=25&offset=50&sort=created',
    );
  });
});

describe('formatActiveDay', () => {
  const now = new Date('2026-09-30T10:00:00Z');
  it('reads as a day, not a time', () => {
    expect(formatActiveDay('2026-09-30T00:00:00.000Z', now)).toBe('Today');
    expect(formatActiveDay('2026-09-29T00:00:00.000Z', now)).toBe('Yesterday');
    expect(formatActiveDay('2026-09-18T00:00:00.000Z', now)).toBe('12 days ago');
    expect(formatActiveDay('2026-06-01T00:00:00.000Z', now)).toBe('2026-06-01');
  });
});
