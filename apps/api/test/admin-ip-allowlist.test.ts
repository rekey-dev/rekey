/**
 * ADMIN_IP_ALLOWLIST, the optional network gate on /api/v1/admin/*.
 *
 * The property under test is ordering as much as filtering: an address outside
 * the list must be refused BEFORE the key is examined, so a caller learns
 * nothing about whether the key they hold is correct. SUPER_ADMIN_KEY is one
 * shared secret over the whole deployment, so that distinction matters.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  adminIpAllowlistWarning,
  assertAdminIpAllowlistValid,
} from "../src/middleware/admin-auth.js";

const KEY = process.env.SUPER_ADMIN_KEY!;

describe("ADMIN_IP_ALLOWLIST", () => {
  const original = process.env.ADMIN_IP_ALLOWLIST;
  let app: FastifyInstance;

  afterEach(async () => {
    if (original === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
    else process.env.ADMIN_IP_ALLOWLIST = original;
    if (app) await app.close();
  });

  it("unset: admin routes behave exactly as before (no network gate)", async () => {
    delete process.env.ADMIN_IP_ALLOWLIST;
    app = await buildApp({ logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).not.toBe(403);
  });

  it("refuses an address outside the list, without consulting the key", async () => {
    process.env.ADMIN_IP_ALLOWLIST = "203.0.113.4";
    app = await buildApp({ logger: false });

    // A CORRECT key must still be refused, proving the gate runs first.
    const withGoodKey = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: { authorization: `Bearer ${KEY}` },
      remoteAddress: "198.51.100.9",
    });
    expect(withGoodKey.statusCode).toBe(403);
    expect(withGoodKey.json().error.code).toBe("ADMIN_IP_NOT_ALLOWED");

    // And a WRONG key from the same address yields the identical response, so
    // the refusal leaks nothing about key validity.
    const withBadKey = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: { authorization: "Bearer not-the-real-key-not-the-real-key" },
      remoteAddress: "198.51.100.9",
    });
    expect(withBadKey.statusCode).toBe(403);
    expect(withBadKey.json().error.code).toBe("ADMIN_IP_NOT_ALLOWED");
  });

  it("admits an address inside the list, then still requires the key", async () => {
    process.env.ADMIN_IP_ALLOWLIST = "198.51.100.0/24, 2001:db8::/32";
    app = await buildApp({ logger: false });

    const wrongKey = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: { authorization: "Bearer not-the-real-key-not-the-real-key" },
      remoteAddress: "198.51.100.9",
    });
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKey.json().error.code).toBe("ADMIN_AUTH_INVALID");

    const rightKey = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: { authorization: `Bearer ${KEY}` },
      remoteAddress: "198.51.100.9",
    });
    expect(rightKey.statusCode).toBe(200);
  });

  it("a malformed entry fails the boot instead of silently matching nothing", async () => {
    process.env.ADMIN_IP_ALLOWLIST = "203.0.113.4, not-an-ip";
    // The danger this guards: `ipMatchesAllowlist` treats an unparseable entry
    // as a non-match, so a typo'd list would lock the operator out with no
    // explanation, or, if it were their only entry, read as empty and leave
    // the gate wide open while they believed it was closed.
    expect(() => assertAdminIpAllowlistValid()).toThrow(/ADMIN_IP_ALLOWLIST/);
    await expect(buildApp({ logger: false })).rejects.toThrow(
      /ADMIN_IP_ALLOWLIST/,
    );
  });

  it("a well-formed list of every supported shape passes validation", () => {
    process.env.ADMIN_IP_ALLOWLIST =
      "203.0.113.4, 10.0.0.0/8, 2001:db8::1, 2001:db8::/32";
    expect(() => assertAdminIpAllowlistValid()).not.toThrow();
  });
});

/**
 * The address the gate checks has to be the caller's own. Behind a proxy the
 * API cannot identify, `request.ip` is the proxy's, shared by everyone behind
 * it, so an allowlist naming it would admit them all. These cases pin the
 * refusal, and pin that a deployment with no allowlist is untouched.
 */
describe("ADMIN_IP_ALLOWLIST with an address the API cannot vouch for", () => {
  const original = process.env.ADMIN_IP_ALLOWLIST;
  let app: FastifyInstance;

  // A private peer that forwarded a client address without the proxy secret:
  // an unidentified proxy, so `request.ip` is the peer (10.0.0.7) and it is
  // not vouched. The allowlist covers that peer's whole range on purpose.
  const throughUnknownProxy = {
    remoteAddress: "10.0.0.7",
    headers: { "x-forwarded-for": "198.51.100.9" },
  } as const;

  afterEach(async () => {
    if (original === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
    else process.env.ADMIN_IP_ALLOWLIST = original;
    if (app) await app.close();
  });

  it("refuses, naming the reason, rather than admitting everyone behind the proxy", async () => {
    process.env.ADMIN_IP_ALLOWLIST = "10.0.0.0/8";
    app = await buildApp({ logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: {
        authorization: `Bearer ${KEY}`,
        ...throughUnknownProxy.headers,
      },
      remoteAddress: throughUnknownProxy.remoteAddress,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ADMIN_IP_UNVERIFIABLE");
    // The refusal has to say how to get out of it.
    expect(res.json().error.fix).toMatch(/API_PROXY_SECRET/);
    expect(res.json().error.fix).toMatch(/ADMIN_IP_ALLOWLIST/);
  });

  it("refuses the same way with a wrong key, so it still leaks nothing", async () => {
    process.env.ADMIN_IP_ALLOWLIST = "10.0.0.0/8";
    app = await buildApp({ logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: {
        authorization: "Bearer not-the-real-key-not-the-real-key",
        ...throughUnknownProxy.headers,
      },
      remoteAddress: throughUnknownProxy.remoteAddress,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ADMIN_IP_UNVERIFIABLE");
  });

  it("with NO allowlist configured, the same request is unaffected", async () => {
    delete process.env.ADMIN_IP_ALLOWLIST;
    app = await buildApp({ logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: {
        authorization: `Bearer ${KEY}`,
        ...throughUnknownProxy.headers,
      },
      remoteAddress: throughUnknownProxy.remoteAddress,
    });
    expect(res.statusCode).toBe(200);
  });

  it("admits a vouched allowlisted address through the same proxy", async () => {
    process.env.ADMIN_IP_ALLOWLIST = "198.51.100.0/24";
    app = await buildApp({
      logger: false,
      apiProxy: { secret: "proxy-secret-for-this-test", hops: 1 },
    });

    const rightKey = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: {
        authorization: `Bearer ${KEY}`,
        "x-forwarded-for": "198.51.100.9",
        "x-rekey-proxy-secret": "proxy-secret-for-this-test",
      },
      remoteAddress: "10.0.0.7",
    });
    expect(rightKey.statusCode).toBe(200);

    // Vouched but outside the list: the pre-existing refusal, unchanged.
    const outside = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: {
        authorization: `Bearer ${KEY}`,
        "x-forwarded-for": "203.0.113.77",
        "x-rekey-proxy-secret": "proxy-secret-for-this-test",
      },
      remoteAddress: "10.0.0.7",
    });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error.code).toBe("ADMIN_IP_NOT_ALLOWED");

    // And the key alone is not enough from a vouched, non-allowlisted address.
    const keyOnly = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tenants",
      headers: { authorization: `Bearer ${KEY}` },
      remoteAddress: "203.0.113.77",
    });
    expect(keyOnly.statusCode).toBe(403);
    expect(keyOnly.json().error.code).toBe("ADMIN_IP_NOT_ALLOWED");
  });

  it("warns at startup exactly when the allowlist cannot be enforced", () => {
    const noSecret = { internalCallers: false as const, proxyHops: 1 };

    process.env.ADMIN_IP_ALLOWLIST = "10.0.0.0/8";
    expect(adminIpAllowlistWarning(noSecret)).toMatch(/API_PROXY_SECRET/);
    expect(
      adminIpAllowlistWarning({ ...noSecret, proxySecret: "set" }),
    ).toBeNull();
    // A hop count vouches every request, so the gate still has an address.
    expect(
      adminIpAllowlistWarning({ ...noSecret, internalCallers: 1 }),
    ).toBeNull();

    delete process.env.ADMIN_IP_ALLOWLIST;
    expect(adminIpAllowlistWarning(noSecret)).toBeNull();
  });
});
