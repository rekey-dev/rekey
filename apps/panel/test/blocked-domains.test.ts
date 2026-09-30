import { describe, expect, it } from 'vitest';
import { domainMatchesRule } from '@rekey.dev/shared-types';
import { apexesWithoutWildcard } from '@/lib/blocked-domains';

describe('apexesWithoutWildcard', () => {
  it('flags an apex blocked without its wildcard', () => {
    expect(apexesWithoutWildcard('x.com')).toEqual(['x.com']);
  });

  it('is quiet once the wildcard is listed too', () => {
    expect(apexesWithoutWildcard('x.com\n*.x.com')).toEqual([]);
    expect(apexesWithoutWildcard(' X.com , *.x.COM ')).toEqual([]);
  });

  it('ignores wildcard-only entries and blank lines, and lists each apex once', () => {
    expect(apexesWithoutWildcard('*.y.com\n\nx.com\nx.com\nz.org')).toEqual(['x.com', 'z.org']);
  });

  it('describes the real matching rule: an apex does not cover its subdomains', () => {
    expect(domainMatchesRule('sub.x.com', 'x.com')).toBe(false);
    expect(domainMatchesRule('sub.x.com', '*.x.com')).toBe(true);
  });
});
