/**
 * ADMIN_IP_ALLOWLIST — the optional network gate on /api/v1/admin/*.
 *
 * The property under test is ordering as much as filtering: an address outside
 * the list must be refused BEFORE the key is examined, so a caller learns
 * nothing about whether the key they hold is correct. SUPER_ADMIN_KEY is one
 * shared secret over the whole deployment, so that distinction matters.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { assertAdminIpAllowlistValid } from '../src/middleware/admin-auth.js';

const KEY = process.env.SUPER_ADMIN_KEY!;

describe('ADMIN_IP_ALLOWLIST', () => {
  const original = process.env.ADMIN_IP_ALLOWLIST;
  let app: FastifyInstance;

  afterEach(async () => {
    if (original === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
    else process.env.ADMIN_IP_ALLOWLIST = original;
    if (app) await app.close();
  });

  it('unset: admin routes behave exactly as before (no network gate)', async () => {
    delete process.env.ADMIN_IP_ALLOWLIST;
    app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tenants',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).not.toBe(403);
  });

  it('refuses an address outside the list, without consulting the key', async () => {
    process.env.ADMIN_IP_ALLOWLIST = '203.0.113.4';
    app = await buildApp({ logger: false });

    // A CORRECT key must still be refused — proving the gate runs first.
    const withGoodKey = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tenants',
      headers: { authorization: `Bearer ${KEY}` },
      remoteAddress: '198.51.100.9',
    });
    expect(withGoodKey.statusCode).toBe(403);
    expect(withGoodKey.json().error.code).toBe('ADMIN_IP_NOT_ALLOWED');

    // And a WRONG key from the same address yields the identical response, so
    // the refusal leaks nothing about key validity.
    const withBadKey = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tenants',
      headers: { authorization: 'Bearer not-the-real-key-not-the-real-key' },
      remoteAddress: '198.51.100.9',
    });
    expect(withBadKey.statusCode).toBe(403);
    expect(withBadKey.json().error.code).toBe('ADMIN_IP_NOT_ALLOWED');
  });

  it('admits an address inside the list, then still requires the key', async () => {
    process.env.ADMIN_IP_ALLOWLIST = '198.51.100.0/24, 2001:db8::/32';
    app = await buildApp({ logger: false });

    const wrongKey = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tenants',
      headers: { authorization: 'Bearer not-the-real-key-not-the-real-key' },
      remoteAddress: '198.51.100.9',
    });
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKey.json().error.code).toBe('ADMIN_AUTH_INVALID');

    const rightKey = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tenants',
      headers: { authorization: `Bearer ${KEY}` },
      remoteAddress: '198.51.100.9',
    });
    expect(rightKey.statusCode).toBe(200);
  });

  it('a malformed entry fails the boot instead of silently matching nothing', async () => {
    process.env.ADMIN_IP_ALLOWLIST = '203.0.113.4, not-an-ip';
    // The danger this guards: `ipMatchesAllowlist` treats an unparseable entry
    // as a non-match, so a typo'd list would lock the operator out with no
    // explanation — or, if it were their only entry, read as empty and leave
    // the gate wide open while they believed it was closed.
    expect(() => assertAdminIpAllowlistValid()).toThrow(/ADMIN_IP_ALLOWLIST/);
    await expect(buildApp({ logger: false })).rejects.toThrow(/ADMIN_IP_ALLOWLIST/);
  });

  it('a well-formed list of every supported shape passes validation', () => {
    process.env.ADMIN_IP_ALLOWLIST = '203.0.113.4, 10.0.0.0/8, 2001:db8::1, 2001:db8::/32';
    expect(() => assertAdminIpAllowlistValid()).not.toThrow();
  });
});
