/**
 * Per-IP guards against the address a proxy leaves behind.
 *
 * When the API cannot tell who is behind a proxy, every request through it has
 * `request.ip` = the proxy's one address. Any guard that BLOCKS by that address
 * then refuses everyone behind it: 100 `Bearer garbage` requests a minute from
 * one anonymous caller would take down every end user, SDK call, secret-key
 * backend and provider webhook. The trust model (lib/client-ip.ts):
 *
 *   - X-Forwarded-For is believed only from our internal callers by address
 *     (panel/portal, TRUSTED_PROXIES) or when our proxy presents
 *     API_PROXY_SECRET as X-Rekey-Proxy-Secret;
 *   - per-IP guards apply only to an address that is the client's; a shared
 *     proxy we cannot identify is never blocked by IP;
 *   - a verified secret key is never refused by the rejected-credential block.
 */

import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { flushApiRequestLogs } from "../src/lib/request-log.js";
import { waitForSecurityEvents } from "./wait-for-security-events.js";
import { createClientIpResolver } from "../src/lib/client-ip.js";
import {
  createVerifiedKeyMemo,
  forgetVerifiedKey,
} from "../src/lib/rate-limit.js";
import { hashKey } from "../src/lib/keys.js";
import type { Redis } from "ioredis";
import type { IncomingMessage } from "node:http";

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const TRAEFIK = "10.0.5.5"; // a proxy on a shared Docker network, no fixed address
const SECRET = "traefik-presents-this-secret-0123456789";

let fixtures: FastifyInstance;
beforeAll(async () => {
  fixtures = await buildApp({ logger: false });
  await fixtures.ready();
});
afterAll(async () => {
  await fixtures.close();
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function enforcedApp(
  options: BuildAppOptions = {},
  trustedProxies?: string,
): Promise<FastifyInstance> {
  const prevEnforce = process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
  const prevTrust = process.env.TRUSTED_PROXIES;
  process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = "1";
  if (trustedProxies === undefined) delete process.env.TRUSTED_PROXIES;
  else process.env.TRUSTED_PROXIES = trustedProxies;
  try {
    const built = await buildApp({ logger: false, ...options });
    await built.ready();
    return built;
  } finally {
    if (prevEnforce === undefined)
      delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
    else process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = prevEnforce;
    if (prevTrust === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = prevTrust;
  }
}

async function makeOperator(tag: string): Promise<string> {
  const res = await fixtures.inject({
    method: "POST",
    url: "/api/v1/tenant/auth/sign-up",
    payload: {
      email: `rlp-${tag}@example.com`,
      password: "pw-one-two-three",
      workspaceName: `WS ${tag}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json().data as { accessToken: string }).accessToken;
}

async function makeKeys(
  slug: string,
): Promise<{
  publicKey: string;
  secretKey: string;
  applicationId: string;
  keyId: string;
}> {
  const tenant = await fixtures
    .inject({
      method: "POST",
      url: "/api/v1/admin/tenants",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: "T", ownerEmail: `owner-${slug}@example.com` },
    })
    .then((r) => r.json().data as { id: string });
  const application = await fixtures
    .inject({
      method: "POST",
      url: "/api/v1/admin/applications",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId: tenant.id, name: "A", slug },
    })
    .then((r) => r.json().data as { id: string; publicKey: string });
  const key = await fixtures
    .inject({
      method: "POST",
      url: `/api/v1/admin/applications/${application.id}/api-keys`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: "backend", mode: "live" },
    })
    .then((r) => r.json().data as { rawKey: string; apiKey: { id: string } });
  return {
    publicKey: application.publicKey,
    secretKey: key.rawKey,
    applicationId: application.id,
    keyId: key.apiKey.id,
  };
}

/** A public request as Traefik delivers it: from Traefik's address, client appended. */
function viaTraefik(
  req: InjectOptions,
  client: string,
  withSecret = false,
): InjectOptions {
  return {
    ...req,
    remoteAddress: TRAEFIK,
    headers: {
      ...(req.headers as Record<string, string>),
      "x-forwarded-for": client,
      ...(withSecret ? { "x-rekey-proxy-secret": SECRET } : {}),
    },
  };
}

const garbage: InjectOptions = {
  method: "GET",
  url: "/api/v1/tenant/auth/me",
  headers: { authorization: "Bearer garbage" },
};

describe("through a proxy we cannot identify (no API_PROXY_SECRET)", () => {
  it("is never blocked by IP: 150 garbage bearers do not lock out anyone else", async () => {
    app = await enforcedApp();
    const { secretKey, publicKey } = await makeKeys("rlp-dos");
    const operator = await makeOperator("dos");

    // The attack: garbage from many "clients", all arriving from Traefik.
    for (let i = 0; i < 150; i++) {
      const r = await app.inject(viaTraefik(garbage, `198.51.100.${i % 250}`));
      expect(r.statusCode).toBe(401);
    }
    // Everyone else behind Traefik is untouched.
    const op = await app.inject(
      viaTraefik(
        {
          method: "GET",
          url: "/api/v1/tenant/auth/me",
          headers: { authorization: `Bearer ${operator}` },
        },
        "203.0.113.1",
      ),
    );
    expect(op.statusCode).toBe(200);
    const backend = await app.inject(
      viaTraefik(
        {
          method: "GET",
          url: "/api/v1/me/",
          headers: { authorization: `Bearer ${secretKey}` },
        },
        "203.0.113.2",
      ),
    );
    expect(backend.statusCode).toBe(200);
    // Anonymous traffic is not counted per (shared) IP either.
    for (let i = 0; i < 120; i++) {
      const r = await app.inject(
        viaTraefik(
          { method: "GET", url: "/api/v1/tenant/auth/signup-mode" },
          "203.0.113.3",
        ),
      );
      expect(r.statusCode).toBe(200);
    }
    // A publishable-key call falls back to a per-Application bucket.
    const pub = await app.inject(
      viaTraefik(
        {
          method: "POST",
          url: "/api/v1/auth/sign-up",
          headers: { authorization: `Bearer ${publicKey}` },
          payload: {
            email: "dos-user@example.com",
            password: "correct-horse-battery",
          },
        },
        "203.0.113.4",
      ),
    );
    expect(pub.statusCode).toBe(201);
  }, 120_000);

  it("an address blocked for its own direct failures still passes traffic it proxies", async () => {
    // The proxy's own address can earn a block honestly (a direct caller with
    // no forwarding header is its own client). What it forwards for others is
    // not that caller, and must not inherit the block.
    app = await enforcedApp();
    for (let i = 0; i < 100; i++)
      await app.inject({ ...garbage, remoteAddress: TRAEFIK });
    expect(
      (await app.inject({ ...garbage, remoteAddress: TRAEFIK })).statusCode,
    ).toBe(429);
    const operator = await makeOperator("proxied");
    const proxied = await app.inject(
      viaTraefik(
        {
          method: "GET",
          url: "/api/v1/tenant/auth/me",
          headers: { authorization: `Bearer ${operator}` },
        },
        "203.0.113.60",
      ),
    );
    expect(proxied.statusCode).toBe(200);
  });

  it("does not apply the per-IP ceiling across identities to the shared address", async () => {
    app = await enforcedApp({ rateLimitOverrides: { authenticatedPerIp: 3 } });
    const tokens = await Promise.all([
      makeOperator("ceil-a"),
      makeOperator("ceil-b"),
    ]);
    for (let i = 0; i < 8; i++) {
      const r = await app.inject(
        viaTraefik(
          {
            method: "GET",
            url: "/api/v1/tenant/auth/me",
            headers: { authorization: `Bearer ${tokens[i % 2]}` },
          },
          `203.0.113.${10 + i}`,
        ),
      );
      expect(r.statusCode).toBe(200);
    }
  });
});

describe("through our proxy, proven by API_PROXY_SECRET", () => {
  it("limits per real client", async () => {
    app = await enforcedApp({ apiProxy: { secret: SECRET, hops: 1 } });
    for (let i = 0; i < 100; i++) {
      expect(
        (await app.inject(viaTraefik(garbage, "198.51.100.20", true)))
          .statusCode,
      ).toBe(401);
    }
    expect(
      (await app.inject(viaTraefik(garbage, "198.51.100.20", true))).statusCode,
    ).toBe(429);
    // Another client through the same proxy: its own bucket.
    expect(
      (await app.inject(viaTraefik(garbage, "198.51.100.21", true))).statusCode,
    ).toBe(401);
  });

  it("with a CDN in front, takes the second entry from the right and ignores what the client prepended", async () => {
    app = await enforcedApp({ apiProxy: { secret: SECRET, hops: 2 } });
    const chain = (client: string) =>
      `6.6.6.${Math.floor(Math.random() * 250)}, ${client}, 203.0.113.250`;
    for (let i = 0; i < 100; i++) {
      await app.inject(viaTraefik(garbage, chain("198.51.100.30"), true));
    }
    expect(
      (await app.inject(viaTraefik(garbage, chain("198.51.100.30"), true)))
        .statusCode,
    ).toBe(429);
    expect(
      (await app.inject(viaTraefik(garbage, chain("198.51.100.31"), true)))
        .statusCode,
    ).toBe(401);
  });

  it("ignores a forged X-Forwarded-For without the secret: a public caller is its own address", async () => {
    app = await enforcedApp({ apiProxy: { secret: SECRET, hops: 1 } });
    // A direct caller rotating the header.
    for (let i = 0; i < 100; i++) {
      const r = await app.inject({
        method: "GET",
        url: "/api/v1/tenant/auth/signup-mode",
        remoteAddress: "203.0.113.44",
        headers: { "x-forwarded-for": `192.0.2.${i}` },
      });
      expect(r.statusCode).toBe(200);
    }
    const over = await app.inject({
      method: "GET",
      url: "/api/v1/tenant/auth/signup-mode",
      remoteAddress: "203.0.113.44",
      headers: {
        "x-forwarded-for": "192.0.2.250",
        "x-rekey-proxy-secret": "guessed-wrong",
      },
    });
    expect(over.statusCode).toBe(429);
  });

  it("a private peer forwarding without the secret is never IP-blocked, even with the secret configured", async () => {
    // Traefik on a router that lost the secret middleware: every public
    // request arrives from its one private address, forwarding, no secret.
    // Blocking that address would refuse everyone behind it.
    app = await enforcedApp({ apiProxy: { secret: SECRET, hops: 1 } });
    for (let i = 0; i < 150; i++) {
      expect(
        (await app.inject(viaTraefik(garbage, `198.51.100.${i % 250}`)))
          .statusCode,
      ).toBe(401);
    }
    const operator = await makeOperator("lost-middleware");
    const valid = await app.inject(
      viaTraefik(
        {
          method: "GET",
          url: "/api/v1/tenant/auth/me",
          headers: { authorization: `Bearer ${operator}` },
        },
        "203.0.113.2",
      ),
    );
    expect(valid.statusCode).toBe(200);
  });

  it("warns once, not per request, that a proxy route is missing the secret", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    app = await enforcedApp({
      logger: { level: "warn", stream },
      apiProxy: { secret: SECRET, hops: 1 },
    });
    for (let i = 0; i < 5; i++)
      await app.inject(
        viaTraefik({ method: "GET", url: "/health/live" }, `198.51.100.${i}`),
      );
    const warnings = lines.filter((l) =>
      l.includes("without X-Rekey-Proxy-Secret"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(TRAEFIK);
  });

  it("a forged address cannot pass ADMIN_IP_ALLOWLIST; the proxy-vouched one can", async () => {
    const prev = process.env.ADMIN_IP_ALLOWLIST;
    process.env.ADMIN_IP_ALLOWLIST = "192.0.2.1";
    try {
      app = await enforcedApp({ apiProxy: { secret: SECRET, hops: 1 } });
      const admin = (headers: Record<string, string>): InjectOptions => ({
        method: "GET",
        url: "/api/v1/admin/tenants",
        remoteAddress: "10.0.1.99",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, ...headers },
      });
      // Unvouched: the API sees only the private peer, shared by everyone
      // behind it, so the allowlist cannot be enforced and refuses outright.
      const forged = await app.inject(
        admin({ "x-forwarded-for": "192.0.2.1" }),
      );
      expect(forged.statusCode).toBe(403);
      expect(forged.json().error.code).toBe("ADMIN_IP_UNVERIFIABLE");
      const vouched = await app.inject(
        admin({
          "x-forwarded-for": "192.0.2.1",
          "x-rekey-proxy-secret": SECRET,
        }),
      );
      expect(vouched.statusCode).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
      else process.env.ADMIN_IP_ALLOWLIST = prev;
    }
  });
});

describe("the rejected-credential block and secret keys", () => {
  const me = (key: string): InjectOptions => ({
    method: "GET",
    url: "/api/v1/me/",
    headers: { authorization: `Bearer ${key}` },
  });

  it("lets a key that has verified through, and refuses forged keys before the lookup", async () => {
    app = await enforcedApp({ apiProxy: { secret: SECRET, hops: 1 } });
    const { secretKey } = await makeKeys("rlp-key");
    const client = "198.51.100.40";
    // The backend has been working normally from this address.
    expect(
      (await app.inject(viaTraefik(me(secretKey), client, true))).statusCode,
    ).toBe(200);
    // Then something else at the same address sprays forged keys: each is a
    // rejected credential and counts toward the block.
    for (let i = 0; i < 100; i++) {
      const r = await app.inject(
        viaTraefik(me(`rp_live_forged${i}000000000000000000`), client, true),
      );
      expect(r.statusCode).toBe(401);
    }
    // Blocked: forged keys, key-shaped or not, are now refused before any lookup.
    const forged = await app.inject(
      viaTraefik(me("rp_live_forged-after-block-0000000"), client, true),
    );
    expect(forged.statusCode).toBe(429);
    expect(
      (await app.inject(viaTraefik(garbage, client, true))).statusCode,
    ).toBe(429);
    // The verified key still works.
    expect(
      (await app.inject(viaTraefik(me(secretKey), client, true))).statusCode,
    ).toBe(200);
  });

  it("a key never seen before waits out the block like any other credential", async () => {
    app = await enforcedApp({ apiProxy: { secret: SECRET, hops: 1 } });
    const { secretKey } = await makeKeys("rlp-newkey");
    const client = "198.51.100.41";
    for (let i = 0; i < 100; i++)
      await app.inject(viaTraefik(garbage, client, true));
    expect(
      (await app.inject(viaTraefik(me(secretKey), client, true))).statusCode,
    ).toBe(429);
    // From an address that is not blocked, it verifies, and is known from then on.
    expect(
      (await app.inject(viaTraefik(me(secretKey), "198.51.100.42", true)))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject(viaTraefik(me(secretKey), client, true))).statusCode,
    ).toBe(200);
  });
});

describe("the auth tier through an unidentified proxy", () => {
  const verify = (token: string): InjectOptions => ({
    method: "POST",
    url: "/api/v1/tenant/auth/magic-link/verify",
    payload: { token },
  });

  it("does not share one bucket across everyone behind the proxy on subject-less routes", async () => {
    app = await enforcedApp();
    for (let i = 0; i < 10; i++) {
      const r = await app.inject(
        viaTraefik(verify(`bogus-${i}`), `198.51.100.${100 + i}`),
      );
      expect(r.statusCode).not.toBe(429);
    }
    const bystander = await app.inject(
      viaTraefik(verify("a-real-looking-token"), "203.0.113.77"),
    );
    expect(bystander.statusCode).not.toBe(429);
  });

  it("keeps the per-IP auth cap for an address that is the client's", async () => {
    app = await enforcedApp();
    const direct = (i: number): InjectOptions => ({
      ...verify(`bogus-${i}`),
      remoteAddress: "198.51.100.130",
    });
    for (let i = 0; i < 10; i++)
      expect((await app.inject(direct(i))).statusCode).not.toBe(429);
    expect((await app.inject(direct(10))).statusCode).toBe(429);
  });

  it("still limits per subject when the route names one", async () => {
    app = await enforcedApp();
    const forgot = (client: string): InjectOptions =>
      viaTraefik(
        {
          method: "POST",
          url: "/api/v1/tenant/auth/forgot-password",
          payload: { email: "target@example.com" },
        },
        client,
      );
    for (let i = 0; i < 10; i++)
      await app.inject(forgot(`198.51.100.${140 + i}`));
    // Rotating the address does not escape the per-(subject) bucket.
    expect((await app.inject(forgot("198.51.100.160"))).statusCode).toBe(429);
    // Another subject behind the same proxy is unaffected.
    const other = await app.inject(
      viaTraefik(
        {
          method: "POST",
          url: "/api/v1/tenant/auth/forgot-password",
          payload: { email: "someone-else@example.com" },
        },
        "198.51.100.161",
      ),
    );
    expect(other.statusCode).toBe(200);
  });
});

describe("INTERNAL_CALLER_SECRET: our panel or portal calling through the public edge", () => {
  const CALLER = "panel-and-portal-share-this-secret";
  const EGRESS = "203.0.113.99"; // the host's outgoing address, a public peer
  // What arrives after the CDN and Traefik appended their entries: the
  // caller's egress and the edge, whether or not the caller sent anything.
  const PROXY_CHAIN = `${EGRESS}, 203.0.113.250`;
  const fromCaller = (
    req: InjectOptions,
    clientIp: string | null,
    secret: string | null = CALLER,
  ): InjectOptions => ({
    ...req,
    remoteAddress: EGRESS,
    headers: {
      ...(req.headers as Record<string, string>),
      "x-forwarded-for": PROXY_CHAIN,
      ...(clientIp === null ? {} : { "x-rekey-client-ip": clientIp }),
      ...(secret === null ? {} : { "x-rekey-caller-secret": secret }),
    },
  });

  it("is limited per the client the caller vouched for in X-Rekey-Client-Ip", async () => {
    app = await enforcedApp({ apiProxy: { callerSecret: CALLER } });
    for (let i = 0; i < 100; i++)
      await app.inject(fromCaller(garbage, "198.51.100.80"));
    expect(
      (await app.inject(fromCaller(garbage, "198.51.100.80"))).statusCode,
    ).toBe(429);
    // Another operator through the same panel: own bucket.
    expect(
      (await app.inject(fromCaller(garbage, "198.51.100.81"))).statusCode,
    ).toBe(401);
  });

  it("with no client address from the caller, the proxy chain is NOT believed and nothing is IP-blocked", async () => {
    app = await enforcedApp({ apiProxy: { callerSecret: CALLER } });
    // The panel had no validated visitor (its own check failed): it sends the
    // secret and no X-Rekey-Client-Ip, while the edge still appends to XFF.
    for (let i = 0; i < 150; i++) {
      expect((await app.inject(fromCaller(garbage, null))).statusCode).toBe(
        401,
      );
    }
    const operator = await makeOperator("caller-no-ip");
    const valid = await app.inject(
      fromCaller(
        {
          method: "GET",
          url: "/api/v1/tenant/auth/me",
          headers: { authorization: `Bearer ${operator}` },
        },
        null,
      ),
    );
    expect(valid.statusCode).toBe(200);
  });

  it("a malformed X-Rekey-Client-Ip is treated as absent", async () => {
    app = await enforcedApp({ apiProxy: { callerSecret: CALLER } });
    for (const bad of ["not-an-ip", "198.51.100.1, 198.51.100.2"]) {
      // Believed as a value, either would be one bucket and trip at 101.
      for (let i = 0; i < 150; i++) {
        expect((await app.inject(fromCaller(garbage, bad))).statusCode).toBe(
          401,
        );
      }
    }
  });

  it("X-Rekey-Client-Ip without the secret, or with a wrong one, is ignored", async () => {
    app = await enforcedApp({ apiProxy: { callerSecret: CALLER } });
    // A public peer (not behind any proxy of ours) rotating the header: it is
    // its own address, and the header buys it nothing.
    const direct = (i: number, secret: string | null): InjectOptions => ({
      ...garbage,
      remoteAddress: EGRESS,
      headers: {
        authorization: "Bearer garbage",
        "x-rekey-client-ip": `198.51.100.${i}`,
        ...(secret === null ? {} : { "x-rekey-caller-secret": secret }),
      },
    });
    for (let i = 0; i < 100; i++)
      await app.inject(
        direct(i, i % 2 === 0 ? "wrong-secret-wrong-secret" : null),
      );
    expect((await app.inject(direct(200, null))).statusCode).toBe(429);
  });
});

describe("what reaches logs, request logs and security events", () => {
  it("logs the decided address and never a secret or a forged header", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const CALLER = "caller-secret-that-must-not-leak";
    app = await enforcedApp({
      logger: { level: "info", stream },
      apiProxy: { secret: SECRET, hops: 1, callerSecret: CALLER },
    });
    await app.inject({
      ...garbage,
      remoteAddress: "203.0.113.5",
      headers: {
        authorization: "Bearer garbage",
        "x-forwarded-for": "192.0.2.66",
      },
    });
    await app.inject(viaTraefik(garbage, "198.51.100.90", true));
    await app.inject({
      ...garbage,
      remoteAddress: "203.0.113.6",
      headers: {
        authorization: "Bearer garbage",
        "x-forwarded-for": "192.0.2.88, 203.0.113.250",
        "x-rekey-client-ip": "198.51.100.91",
        "x-rekey-caller-secret": CALLER,
      },
    });
    const out = lines.join("");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(CALLER);
    expect(out).not.toContain("192.0.2.66");
    expect(out).not.toContain("192.0.2.88");
    const incoming = lines.filter((l) => l.includes("incoming request"));
    expect(incoming).toHaveLength(3);
    expect(incoming[0]).toContain('"remoteAddress":"203.0.113.5"');
    expect(incoming[1]).toContain('"remoteAddress":"198.51.100.90"');
    expect(incoming[2]).toContain('"remoteAddress":"198.51.100.91"');
  });

  it("records the decided address in security events and the request log", async () => {
    const CALLER = "caller-secret-for-audit-test-0001";
    app = await enforcedApp({
      apiProxy: { secret: SECRET, hops: 1, callerSecret: CALLER },
    });
    const email = "rlp-audit@example.com";
    const signUp = await fixtures.inject({
      method: "POST",
      url: "/api/v1/tenant/auth/sign-up",
      payload: {
        email,
        password: "pw-one-two-three",
        workspaceName: "WS audit",
      },
    });
    const { accessToken, user } = signUp.json().data as {
      accessToken: string;
      user: { id: string };
    };

    // A forged header from an untrusted peer: the event records the peer.
    await app.inject({
      method: "POST",
      url: "/api/v1/tenant/auth/sign-in",
      remoteAddress: "203.0.113.7",
      headers: { "x-forwarded-for": "192.0.2.77" },
      payload: { email, password: "wrong-password-1" },
    });
    // Through our proxy: the event records the client.
    await app.inject(
      viaTraefik(
        {
          method: "POST",
          url: "/api/v1/tenant/auth/sign-in",
          payload: { email, password: "wrong-password-2" },
        },
        "198.51.100.92",
        true,
      ),
    );
    const events = await waitForSecurityEvents(
      { type: "operator.sign_in_failed", actorId: user.id },
      { atLeast: 2 },
    );
    expect(events.map((e) => e.ip).sort()).toEqual([
      "198.51.100.92",
      "203.0.113.7",
    ]);

    // The request log, through the internal caller path.
    await app.inject({
      method: "GET",
      url: "/api/v1/tenant/auth/me",
      remoteAddress: "203.0.113.8",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-rekey-client-ip": "198.51.100.93",
        "x-rekey-caller-secret": CALLER,
      },
    });
    await flushApiRequestLogs();
    const logged = await prisma.apiRequestLog.findFirst({
      where: { operatorUserId: user.id, routePath: "/api/v1/tenant/auth/me" },
    });
    expect(logged?.ip).toBe("198.51.100.93");
  });
});

describe("the resolver strips what must not travel further", () => {
  const raw = (headers: Record<string, string>, peer: string) =>
    ({
      headers: { ...headers },
      socket: { remoteAddress: peer },
    }) as unknown as IncomingMessage;

  it("removes both secrets, and forwarded host and scheme not from our proxy", () => {
    const resolve = createClientIpResolver({
      internalCallers: false,
      proxySecret: "proxy-secret-proxy-secret",
      proxyHops: 1,
      internalCallerSecret: "caller-secret-caller-secret",
    });
    const direct = raw(
      {
        "x-rekey-caller-secret": "caller-secret-caller-secret",
        "x-rekey-client-ip": "198.51.100.9",
        "x-rekey-proxy-secret": "guess",
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
      "203.0.113.1",
    );
    expect(resolve(direct)).toBe(true);
    expect(direct.headers["x-rekey-caller-secret"]).toBeUndefined();
    expect(direct.headers["x-rekey-client-ip"]).toBeUndefined();
    expect(direct.headers["x-rekey-proxy-secret"]).toBeUndefined();
    expect(direct.headers["x-forwarded-host"]).toBeUndefined();
    expect(direct.headers["x-forwarded-proto"]).toBeUndefined();
    // The caller secret was valid, so the address is the one it vouched for
    // in X-Rekey-Client-Ip, never the X-Forwarded-For it also carried.
    expect(direct.headers["x-forwarded-for"]).toBe("198.51.100.9");

    const viaProxy = raw(
      {
        "x-rekey-proxy-secret": "proxy-secret-proxy-secret",
        "x-forwarded-for": "198.51.100.2",
        "x-forwarded-proto": "https",
      },
      "10.0.5.5",
    );
    expect(resolve(viaProxy)).toBe(true);
    expect(viaProxy.headers["x-rekey-proxy-secret"]).toBeUndefined();
    expect(viaProxy.headers["x-forwarded-proto"]).toBe("https");
  });
});

describe("the verified-key memo forgets a revoked key", () => {
  it("a revoked key no longer passes a blocked address without a lookup", async () => {
    app = await enforcedApp({ apiProxy: { secret: SECRET, hops: 1 } });
    const { secretKey, applicationId, keyId } = await makeKeys("rlp-revoke");
    const client = "198.51.100.170";
    const me: InjectOptions = {
      method: "GET",
      url: "/api/v1/me/",
      headers: { authorization: `Bearer ${secretKey}` },
    };
    expect((await app.inject(viaTraefik(me, client, true))).statusCode).toBe(
      200,
    );
    for (let i = 0; i < 100; i++)
      await app.inject(viaTraefik(garbage, client, true));
    // Still known, so still passes.
    expect((await app.inject(viaTraefik(me, client, true))).statusCode).toBe(
      200,
    );
    const revoked = await fixtures.inject({
      method: "DELETE",
      url: `/api/v1/admin/applications/${applicationId}/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(revoked.statusCode).toBe(200);
    // Refused at the block, before the lookup that would 401 it.
    expect((await app.inject(viaTraefik(me, client, true))).statusCode).toBe(
      429,
    );
  });
});

describe("a failing address resolver does not take the process down", () => {
  it("treats the request as unvouched and serves it", async () => {
    app = await enforcedApp({
      clientIpResolver: () => {
        throw new Error("forced resolver failure");
      },
    });
    for (let i = 0; i < 150; i++) {
      const r = await app.inject({
        ...garbage,
        remoteAddress: "198.51.100.180",
        headers: {
          authorization: "Bearer garbage",
          "x-forwarded-for": "192.0.2.1",
        },
      });
      // Served, never IP-blocked (unvouched), and no crash.
      expect(r.statusCode).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/tenant/auth/signup-mode",
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("verified-key memo across replicas", () => {
  it("a revocation on one replica is seen by every replica, through the shared store", async () => {
    const store = new Map<string, string>();
    const redis = {
      async exists(k: string) {
        return store.has(k) ? 1 : 0;
      },
      async set(k: string, v: string) {
        store.set(k, v);
        return "OK";
      },
      async del(k: string) {
        return store.delete(k) ? 1 : 0;
      },
    } as unknown as Redis;
    const replicaA = createVerifiedKeyMemo({ redis, ttlMs: 60_000 });
    const replicaB = createVerifiedKeyMemo({ redis, ttlMs: 60_000 });
    try {
      await replicaA.remember("rp_live_shared-key");
      await replicaB.remember("rp_live_shared-key");
      expect(await replicaB.known("rp_live_shared-key")).toBe(true);
      // Revoked through replica A's process only (its store delete).
      await replicaA.forget(hashKey("rp_live_shared-key"));
      expect(await replicaB.known("rp_live_shared-key")).toBe(false);
    } finally {
      replicaA.dispose();
      replicaB.dispose();
    }
  });

  it("forgetVerifiedKey reaches every memo in the process", async () => {
    const memo = createVerifiedKeyMemo({ redis: null, ttlMs: 60_000 });
    try {
      await memo.remember("rp_live_local-key");
      expect(await memo.known("rp_live_local-key")).toBe(true);
      await forgetVerifiedKey(hashKey("rp_live_local-key"));
      expect(await memo.known("rp_live_local-key")).toBe(false);
    } finally {
      memo.dispose();
    }
  });
});
