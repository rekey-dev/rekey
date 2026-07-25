/**
 * TRUSTED_PROXIES parsing.
 *
 * This function decides whether `request.ip` is the real socket peer or
 * whatever a client wrote in X-Forwarded-For. Rate limits, account lockout,
 * and IP allowlists all key off that, and the setting it replaced trusted the
 * header from ANY peer — measured as 60/60 requests bypassing the limiter with
 * a rotating XFF. So: no trust-everything option, and anything ambiguous
 * throws at boot instead of degrading silently.
 */

import { describe, expect, it } from 'vitest';
import { trustProxyConfig } from '../src/app.js';

describe('trustProxyConfig', () => {
  it('defaults to false when unset, empty, or whitespace', () => {
    expect(trustProxyConfig(undefined)).toBe(false);
    expect(trustProxyConfig('')).toBe(false);
    expect(trustProxyConfig('   ')).toBe(false);
    expect(trustProxyConfig('false')).toBe(false);
  });

  it('accepts a positive hop count', () => {
    expect(trustProxyConfig('1')).toBe(1);
    expect(trustProxyConfig(' 2 ')).toBe(2);
  });

  it('refuses trust-everything — the setting this replaced', () => {
    // `true` would restore "believe X-Forwarded-For from any peer", which is
    // the vulnerability, not a supported configuration.
    expect(() => trustProxyConfig('true')).toThrow(/not an IP, CIDR/);
  });

  it('rejects hop counts that are not positive integers', () => {
    expect(() => trustProxyConfig('0')).toThrow(/not a valid hop count/);
    expect(() => trustProxyConfig('-1')).toThrow(/not a valid hop count/);
    expect(() => trustProxyConfig('1.5')).toThrow(/not a valid hop count/);
  });

  it('accepts IP and CIDR allowlists', () => {
    expect(trustProxyConfig('10.0.0.1')).toEqual(['10.0.0.1']);
    expect(trustProxyConfig('10.0.0.0/8, 172.16.0.1')).toEqual(['10.0.0.0/8', '172.16.0.1']);
    expect(trustProxyConfig('::1')).toEqual(['::1']);
    expect(trustProxyConfig('loopback,uniquelocal')).toEqual(['loopback', 'uniquelocal']);
  });

  it('throws on malformed entries rather than handing them to proxy-addr', () => {
    expect(() => trustProxyConfig('invalid-cidr')).toThrow(/not an IP, CIDR/);
    expect(() => trustProxyConfig('10.0.0.999')).toThrow(/not an IP, CIDR/);
    expect(() => trustProxyConfig('10.0.0.0/8/16')).toThrow(/not an IP, CIDR/);
    // One bad entry poisons the list — partial trust is not a safe fallback.
    expect(() => trustProxyConfig('10.0.0.1,nope')).toThrow(/nope/);
  });
});
