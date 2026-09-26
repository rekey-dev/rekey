import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/lib/safe-next';

/**
 * The `?next=` validator, which was wrong in four separate copies.
 *
 * Each copy tested `startsWith('/') && !startsWith('//') && !startsWith('/\\')
 * && !includes('://')`. That reads as airtight and is not, because browsers
 * strip tab, LF and CR out of a URL before parsing it: `/%09/evil.com` decodes
 * to `/<TAB>/evil.com`, passes all four tests, and then resolves to
 * `https://evil.com/` once the browser removes the tab.
 *
 * The escape assertions below are written as "resolve it the way a browser
 * would and check the origin", not as "does it match a blocklist". A payload
 * spelled some way nobody predicted still fails the origin check.
 */
const ORIGIN = 'https://panel.rekey.dev';
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** Where a browser would actually land, given what the validator returned. */
function landsOn(next: string | null): string | null {
  return next === null ? null : new URL(next, ORIGIN).origin;
}

describe('safeNext', () => {
  it('keeps ordinary in-app destinations, with query and hash', () => {
    expect(safeNext('/dashboard')).toBe('/dashboard');
    expect(safeNext('/applications?tab=keys#top')).toBe('/applications?tab=keys#top');
  });

  it.each([
    ['protocol-relative', '//evil.com'],
    ['absolute', 'https://evil.com'],
    ['backslash', '/\\evil.com'],
    ['tab', `/${TAB}/evil.com`],
    ['newline', `/${LF}/evil.com`],
    ['carriage return', `/${CR}/evil.com`],
    ['repeated tab', `/${TAB}${TAB}/evil.com`],
    ['tab before scheme', `/${TAB}https://evil.com`],
  ])('never lets a %s payload leave the origin', (_label, payload) => {
    const next = safeNext(payload);
    // Either refused outright, or rewritten to something that still resolves
    // to us. Both are safe; landing anywhere else is not.
    expect(landsOn(next)).not.toBe('https://evil.com');
    if (next !== null) expect(landsOn(next)).toBe(ORIGIN);
  });

  it('specifically refuses the control-character bypass the four copies allowed', () => {
    // The old predicate, reproduced, to show what this test is defending.
    const old = (v: string) =>
      v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && !v.includes('://')
        ? v
        : null;
    const payload = `/${TAB}/evil.com`;

    expect(landsOn(old(payload))).toBe('https://evil.com');
    expect(safeNext(payload)).toBeNull();
  });

  // These pass every test on the INPUT and only escape once the URL parser has
  // collapsed their dot-segments (or turned `\` into `/`): the old validator
  // returned `//evil.com` for all of the first four. `/%09/evil.com` is the
  // literal percent form, which must stay an in-app path.
  it.each([
    ['dot-segment', '/..//evil.com'],
    ['nested dot-segment', '/x/..//evil.com'],
    ['dot then backslash', '/./\\evil.com'],
    ['encoded dot-segment', '/%2e%2e//evil.com'],
    ['mixed encoded dot-segment', '/x/.%2E//evil.com'],
    ['literal %09', '/%09/evil.com'],
    ['tab', '/\t/evil.com'],
    ['protocol-relative', '//evil.com'],
    ['backslash', '/\\evil.com'],
    ['absolute', 'https://evil.com'],
  ])('never returns anything a browser would resolve off-site (%s)', (_label, payload) => {
    const next = safeNext(payload);
    if (next !== null) {
      expect(next.startsWith('//')).toBe(false);
      expect(next.startsWith('/\\')).toBe(false);
      expect(landsOn(next)).toBe(ORIGIN);
    }
  });

  it('refuses the dot-segment collapse outright rather than rewriting it', () => {
    expect(safeNext('/..//evil.com')).toBeNull();
    expect(safeNext('/x/..//evil.com')).toBeNull();
    expect(safeNext('/%2e%2e//evil.com')).toBeNull();
    expect(safeNext('/./\\evil.com')).toBeNull();
  });

  it('still normalises an ordinary dot-segment and keeps query and hash', () => {
    expect(safeNext('/applications/../team?tab=invites#pending')).toBe('/team?tab=invites#pending');
    expect(safeNext('/%09/evil.com?x=1#h')).toBe('/%09/evil.com?x=1#h');
  });

  it('treats a missing or empty value as no destination', () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext('')).toBeNull();
  });
});
