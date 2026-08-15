import { describe, expect, it } from 'vitest';
import { clientIpFrom } from '../src/lib/client-ip';

/**
 * The forwarded-client-IP helper, which took the wrong end of the list.
 *
 * Proxies APPEND to `X-Forwarded-For`, so the leftmost entry is whatever the
 * client sent and the rightmost is what our own edge wrote. Reading `[0]` gave
 * an attacker a free hand over a value the API then uses for audit-log
 * attribution, rate-limit bucketing and `ADMIN_IP_ALLOWLIST`.
 */
describe('clientIpFrom', () => {
  it('takes the entry our proxy appended, not the one the client sent', () => {
    // The attacker sent "203.0.113.9"; our edge appended the real address.
    expect(clientIpFrom('203.0.113.9, 198.51.100.7')).toBe('198.51.100.7');
  });

  it('is not fooled by a longer forged prefix', () => {
    expect(clientIpFrom('1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.7')).toBe('198.51.100.7');
  });

  it('handles the single-hop case', () => {
    expect(clientIpFrom('198.51.100.7')).toBe('198.51.100.7');
  });

  it('tolerates whitespace and empty segments', () => {
    expect(clientIpFrom('  203.0.113.9 ,  198.51.100.7  ')).toBe('198.51.100.7');
    expect(clientIpFrom('203.0.113.9, ,198.51.100.7')).toBe('198.51.100.7');
  });

  it('falls back to X-Real-IP, which is a single proxy-set value', () => {
    expect(clientIpFrom(null, '198.51.100.7')).toBe('198.51.100.7');
    expect(clientIpFrom('', '198.51.100.7')).toBe('198.51.100.7');
  });

  it('returns null when there is nothing trustworthy to report', () => {
    expect(clientIpFrom(null)).toBeNull();
    expect(clientIpFrom('')).toBeNull();
    expect(clientIpFrom('   ')).toBeNull();
    expect(clientIpFrom(', ,')).toBeNull();
  });

  it('differs from the old leftmost read on exactly the forgeable case', () => {
    const header = '203.0.113.9, 198.51.100.7';
    const oldWay = (header.split(',')[0] ?? '').trim();

    expect(oldWay).toBe('203.0.113.9'); // attacker-controlled
    expect(clientIpFrom(header)).toBe('198.51.100.7'); // proxy-written
  });
});
