/**
 * What the portal forwards as the visitor's address.
 *
 * The API believes the portal's X-Forwarded-For (TRUSTED_PROXIES names the
 * portal's fixed address), so this value picks the visitor's rate-limit bucket.
 * A value a client, or a sibling container reaching the portal around Traefik,
 * can choose is a value that resets their limits.
 */

import { describe, expect, it } from 'vitest';
import { apiCallHeaders, vouchedClientIp } from '@/lib/client-ip';

const SECRET = 'a-proxy-secret-of-some-length';
const via = (hops: string | undefined, presented: string | null = SECRET, secret: string | undefined = SECRET) => ({
  hops,
  secret,
  presentedSecret: presented,
});

describe('vouchedClientIp', () => {
  it('forwards nothing when no proxy of ours is configured', () => {
    expect(vouchedClientIp('198.51.100.7', via(undefined))).toBeNull();
    expect(vouchedClientIp('198.51.100.7', via(''))).toBeNull();
    expect(vouchedClientIp('198.51.100.7', via('0'))).toBeNull();
    expect(vouchedClientIp('198.51.100.7', via('true'))).toBeNull();
    expect(vouchedClientIp('198.51.100.7', via('1.5'))).toBeNull();
  });

  it('forwards nothing without the proxy secret, whatever the hop count', () => {
    // A sibling container calling portal:3050 directly: right hop count, no secret.
    expect(vouchedClientIp('198.51.100.7', via('1', null))).toBeNull();
    expect(vouchedClientIp('198.51.100.7', via('1', 'wrong-secret'))).toBeNull();
    // No secret configured: never believed.
    expect(
      vouchedClientIp('198.51.100.7', { hops: '1', secret: undefined, presentedSecret: SECRET }),
    ).toBeNull();
    expect(vouchedClientIp('198.51.100.7', via('1', '', ''))).toBeNull();
  });

  it('takes the entry our one proxy appended, never a client-prepended one', () => {
    expect(vouchedClientIp('198.51.100.7', via('1'))).toBe('198.51.100.7');
    expect(vouchedClientIp('6.6.6.6, 198.51.100.7', via('1'))).toBe('198.51.100.7');
    expect(vouchedClientIp(' 6.6.6.6 ,198.51.100.7 ', via('1'))).toBe('198.51.100.7');
  });

  it('counts hops from the right when two proxies sit in front', () => {
    expect(vouchedClientIp('6.6.6.6, 198.51.100.7, 203.0.113.1', via('2'))).toBe('198.51.100.7');
  });

  it('forwards exactly one valid address or nothing', () => {
    expect(vouchedClientIp(null, via('1'))).toBeNull();
    expect(vouchedClientIp('', via('1'))).toBeNull();
    expect(vouchedClientIp('198.51.100.7', via('2'))).toBeNull();
    expect(vouchedClientIp('not-an-ip', via('1'))).toBeNull();
    expect(vouchedClientIp('1.2.3.4, 5.6.7.8', via('1'))).toBe('5.6.7.8');
    expect(vouchedClientIp('2001:db8::1', via('1'))).toBe('2001:db8::1');
  });
});

describe('apiCallHeaders', () => {
  it('sends the internal caller secret on every call when it is configured', () => {
    expect(apiCallHeaders('198.51.100.7', 'internal-caller-secret-1')).toEqual({
      'x-rekey-caller-secret': 'internal-caller-secret-1',
      'x-rekey-client-ip': '198.51.100.7',
      'x-forwarded-for': '198.51.100.7',
    });
    // No visitor address: no address header of either kind, so the API sees
    // the portal's own address and does not block by it.
    expect(apiCallHeaders(null, 'internal-caller-secret-1')).toEqual({
      'x-rekey-caller-secret': 'internal-caller-secret-1',
    });
  });

  it('sends no secret header when none is configured', () => {
    expect(apiCallHeaders('198.51.100.7', undefined)).toEqual({
      'x-rekey-client-ip': '198.51.100.7',
      'x-forwarded-for': '198.51.100.7',
    });
    expect(apiCallHeaders(null, '  ')).toEqual({});
  });
});
