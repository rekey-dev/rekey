/**
 * The sidebar says which build is deployed. It must say one build when the
 * panel and API match, both when they differ, and nothing when the API did not
 * answer, and never put an arbitrary string from a proxy on screen.
 */

import { describe, expect, it } from 'vitest';
import { parseBuildInfo, resolveCommit, versionBadge, versionLine } from '../src/lib/build-info';

const same = { version: '2.2.0-rc.4', commit: 'a1b2c3d4e5' };

describe('versionLine', () => {
  it('shows one build with a short commit when panel and API match', () => {
    expect(versionLine(same, same)).toBe('Rekey v2.2.0-rc.4 · a1b2c3d');
  });

  it('shows the version alone when neither knows its commit', () => {
    const v = { version: '2.2.0', commit: 'unknown' };
    expect(versionLine(v, v)).toBe('Rekey v2.2.0');
  });

  it('uses whichever side knows the commit when versions match', () => {
    expect(versionLine(same, { version: '2.2.0-rc.4', commit: 'unknown' })).toBe('Rekey v2.2.0-rc.4 · a1b2c3d');
  });

  it('shows both builds when the versions differ', () => {
    expect(versionLine({ version: '2.2.0', commit: 'unknown' }, { version: '2.1.0', commit: 'bbbbbbb' })).toBe(
      'Panel v2.2.0 · API v2.1.0 · bbbbbbb',
    );
  });

  it('shows both builds when the versions match but the commits differ', () => {
    expect(versionLine(same, { version: same.version, commit: 'fffffff' })).toBe(
      'Panel v2.2.0-rc.4 · a1b2c3d · API v2.2.0-rc.4 · fffffff',
    );
  });

  it('shows nothing when the API did not answer', () => {
    expect(versionLine(same, null)).toBeNull();
  });
});

describe('parseBuildInfo', () => {
  it('accepts the /health/live body', () => {
    expect(parseBuildInfo({ status: 'ok', service: 'rekey-api', version: '2.2.0-rc.4', commit: 'ABCDEF1' })).toEqual({
      version: '2.2.0-rc.4',
      commit: 'abcdef1',
    });
  });

  it('refuses anything that is not a release version', () => {
    expect(parseBuildInfo(null)).toBeNull();
    expect(parseBuildInfo('<html>')).toBeNull();
    expect(parseBuildInfo({ version: '<script>alert(1)</script>' })).toBeNull();
    expect(parseBuildInfo({ version: 'latest' })).toBeNull();
  });

  it('reads a malformed commit as unknown', () => {
    expect(resolveCommit('main')).toBe('unknown');
    expect(parseBuildInfo({ version: '2.2.0', commit: 42 })).toEqual({ version: '2.2.0', commit: 'unknown' });
  });
});

describe('versionBadge', () => {
  it('labels the panel version and links its release notes', () => {
    expect(versionBadge(same, same)).toEqual({
      label: 'v2.2.0-rc.4',
      title: 'Rekey v2.2.0-rc.4 · a1b2c3d',
      mismatch: false,
      href: 'https://github.com/rekey-dev/rekey/releases/tag/v2.2.0-rc.4',
    });
  });

  it('flags a panel and API on different builds', () => {
    const badge = versionBadge({ version: '2.2.1', commit: 'unknown' }, { version: '2.2.0', commit: 'unknown' });
    expect(badge).toMatchObject({
      label: 'v2.2.1 · API v2.2.0',
      title: 'Panel v2.2.1 · API v2.2.0',
      mismatch: true,
      href: 'https://github.com/rekey-dev/rekey/releases',
    });
  });

  it('still renders when the API did not answer, and says so', () => {
    const badge = versionBadge({ version: '2.2.1', commit: 'unknown' }, null);
    expect(badge).toMatchObject({
      label: 'v2.2.1 · API ?',
      mismatch: false,
      title: 'Panel v2.2.1 · API version unavailable',
    });
  });
});
