/**
 * Which host a request names, and which hosts can be a custom domain at all.
 */

import { describe, expect, it } from 'vitest';
import { customDomainOrigin, domainName, publicHost } from '@/lib/portal-host';

describe('domainName', () => {
  it('lower-cases and drops the port and a trailing dot', () => {
    expect(domainName('Billing.Acme.COM:8443')).toBe('billing.acme.com');
    expect(domainName('billing.acme.com.')).toBe('billing.acme.com');
  });

  it.each(['127.0.0.1', '127.0.0.1:3050', '[::1]:3050', 'localhost', 'portal:3050', 'a_b.example.com', 'evil.com/x', '', null])(
    'refuses %s',
    (raw) => {
      expect(domainName(raw)).toBeNull();
    },
  );
});

describe('publicHost', () => {
  const secret = 'proxy-secret';

  it('reads Host when nothing vouches for X-Forwarded-Host', () => {
    const headers = new Headers({ host: 'portal.example', 'x-forwarded-host': 'billing.victim.test' });
    expect(publicHost(headers, secret)).toBe('portal.example');
    headers.set('x-rekey-proxy-secret', 'wrong');
    expect(publicHost(headers, secret)).toBe('portal.example');
    headers.set('x-rekey-proxy-secret', secret);
    expect(publicHost(headers, undefined)).toBe('portal.example');
  });

  it('reads the first X-Forwarded-Host from the proxy holding the secret', () => {
    const headers = new Headers({
      host: 'portal:3050',
      'x-forwarded-host': 'billing.acme.test, inner.proxy',
      'x-rekey-proxy-secret': secret,
    });
    expect(publicHost(headers, secret)).toBe('billing.acme.test');
  });
});

describe('customDomainOrigin', () => {
  it('is always https', () => {
    expect(customDomainOrigin('billing.acme.test')).toBe('https://billing.acme.test');
  });
});
