/**
 * Limits that identity keying (test/rate-limit-keying.test.ts) depends on. A
 * per-identity budget is only safe when:
 *
 *   - Routes that check a SECRET inside an authenticated session (change
 *     password, passkey enrolment's step-up) had no per-route cap, so moving the
 *     operator and end user to a 600/min identity budget turned the current
 *     password into a 600-guesses-a-minute oracle with no lockout.
 *   - A REJECTED credential never reached the limiter (the auth hook throws
 *     first), so garbage bearers, fake keys and forged tokens were unmetered
 *     database lookups.
 *   - One address could mint end users (sign-up had no cap) and spend a full
 *     authenticated budget for each.
 *   - A hop-count TRUSTED_PROXIES on a network shared with other containers let
 *     any of them forge the client address.
 *
 * Same harness as the keying suite: an ordinary app for fixtures, a second one
 * with the real caps on (`REKEY_TEST_ENFORCE_RATE_LIMITS=1`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from "fastify";
import { buildApp, type BuildAppOptions } from "../src/app.js";

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

let fixtures: FastifyInstance;

beforeAll(async () => {
  fixtures = await buildApp({ logger: false });
  await fixtures.ready();
});

afterAll(async () => {
  await fixtures.close();
});

async function enforcedApp(
  trustedProxies?: string,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const prevEnforce = process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
  const prevTrust = process.env.TRUSTED_PROXIES;
  process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = "1";
  if (trustedProxies === undefined) delete process.env.TRUSTED_PROXIES;
  else process.env.TRUSTED_PROXIES = trustedProxies;
  try {
    const app = await buildApp({ logger: false, ...options });
    await app.ready();
    return app;
  } finally {
    if (prevEnforce === undefined)
      delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
    else process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = prevEnforce;
    if (prevTrust === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = prevTrust;
  }
}

async function fire(
  app: FastifyInstance,
  n: number,
  req: InjectOptions,
): Promise<LightMyRequestResponse[]> {
  const out: LightMyRequestResponse[] = [];
  for (let i = 0; i < n; i++) out.push(await app.inject(req));
  return out;
}

const PASSWORD = "pw-one-two-three";

async function makeOperator(
  tag: string,
): Promise<{ accessToken: string; email: string }> {
  const email = `rlh-${tag}@example.com`;
  const res = await fixtures.inject({
    method: "POST",
    url: "/api/v1/tenant/auth/sign-up",
    payload: { email, password: PASSWORD, workspaceName: `WS ${tag}` },
  });
  expect(res.statusCode).toBe(201);
  return {
    accessToken: (res.json().data as { accessToken: string }).accessToken,
    email,
  };
}

async function makeApplication(
  slug: string,
): Promise<{ publicKey: string; secretKey: string }> {
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
    .then((r) => r.json().data as { rawKey: string });
  return { publicKey: application.publicKey, secretKey: key.rawKey };
}

async function makeEndUser(publicKey: string, email: string): Promise<string> {
  const res = await fixtures.inject({
    method: "POST",
    url: "/api/v1/auth/sign-up",
    headers: { authorization: `Bearer ${publicKey}` },
    payload: { email, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(201);
  return (res.json().data as { accessToken: string }).accessToken;
}

describe("routes that verify a secret inside a session stay at 10", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await enforcedApp();
  });
  afterEach(async () => {
    await app?.close();
  });

  it("operator change-password: the 11th wrong current password is a 429", async () => {
    const op = await makeOperator("cp");
    const req: InjectOptions = {
      method: "POST",
      url: "/api/v1/tenant/auth/change-password",
      remoteAddress: "198.51.100.10",
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: {
        currentPassword: "wrong-guess",
        newPassword: "another-long-password-1",
      },
    };
    const tries = await fire(app, 10, req);
    expect(tries.map((r) => r.statusCode)).toEqual(Array(10).fill(401));
    expect(tries[0]!.headers["x-ratelimit-limit"]).toBe("10");
    const over = await app.inject(req);
    expect(over.statusCode).toBe(429);
  });

  it("one operator exhausting the cap does not spend another operator's from the same IP", async () => {
    const a = await makeOperator("cp-a");
    const b = await makeOperator("cp-b");
    const attempt = (token: string): InjectOptions => ({
      method: "POST",
      url: "/api/v1/tenant/auth/change-password",
      remoteAddress: "198.51.100.14",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        currentPassword: "wrong-guess",
        newPassword: "another-long-password-1",
      },
    });
    await fire(app, 10, attempt(a.accessToken));
    expect((await app.inject(attempt(a.accessToken))).statusCode).toBe(429);
    expect((await app.inject(attempt(b.accessToken))).statusCode).toBe(401);
  });

  it("end-user change-password: the 11th wrong current password is a 429", async () => {
    const { publicKey } = await makeApplication("rlh-cp");
    const token = await makeEndUser(publicKey, "cp-user@example.com");
    const req: InjectOptions = {
      method: "POST",
      url: "/api/v1/auth/change-password",
      remoteAddress: "198.51.100.11",
      headers: {
        authorization: `Bearer ${publicKey}`,
        "x-rekey-user-token": token,
      },
      payload: {
        currentPassword: "wrong-guess",
        newPassword: "another-long-password-1",
      },
    };
    const tries = await fire(app, 10, req);
    expect(tries.map((r) => r.statusCode)).toEqual(Array(10).fill(401));
    expect(tries[0]!.headers["x-ratelimit-limit"]).toBe("10");
    expect((await app.inject(req)).statusCode).toBe(429);
  });

  it("passkey enrolment step-up (operator and end user) caps at 10", async () => {
    const op = await makeOperator("pk");
    const opReq: InjectOptions = {
      method: "POST",
      url: "/api/v1/tenant/auth/passkeys/register/start",
      remoteAddress: "198.51.100.12",
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: { password: "wrong-guess" },
    };
    const opTries = await fire(app, 10, opReq);
    expect(opTries.every((r) => r.statusCode === 401)).toBe(true);
    expect((await app.inject(opReq)).statusCode).toBe(429);

    const { publicKey } = await makeApplication("rlh-pk");
    const token = await makeEndUser(publicKey, "pk-user@example.com");
    const euReq: InjectOptions = {
      method: "POST",
      url: "/api/v1/auth/passkey/register/start",
      remoteAddress: "198.51.100.13",
      headers: {
        authorization: `Bearer ${publicKey}`,
        "x-rekey-user-token": token,
      },
      payload: { password: "wrong-guess" },
    };
    const euTries = await fire(app, 10, euReq);
    expect(euTries.every((r) => r.statusCode === 401)).toBe(true);
    expect((await app.inject(euReq)).statusCode).toBe(429);
  });
});

describe("a wrong current password counts toward the account lockout", () => {
  // Through the ordinary app: request-rate caps are off, so what trips here
  // is the brute-force lockout alone.
  it("operator: ten wrong change-password attempts lock sign-in", async () => {
    const op = await makeOperator("lock");
    for (let i = 0; i < 10; i++) {
      const r = await fixtures.inject({
        method: "POST",
        url: "/api/v1/tenant/auth/change-password",
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: {
          currentPassword: `wrong-${i}`,
          newPassword: "another-long-password-1",
        },
      });
      expect(r.statusCode).toBe(401);
    }
    const locked = await fixtures.inject({
      method: "POST",
      url: "/api/v1/tenant/auth/change-password",
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: {
        currentPassword: PASSWORD,
        newPassword: "another-long-password-1",
      },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("TOO_MANY_FAILED_ATTEMPTS");
    const signIn = await fixtures.inject({
      method: "POST",
      url: "/api/v1/tenant/auth/sign-in",
      payload: { email: op.email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(429);
  });

  it("a wrong password on the passkey step-up counts too (operator and end user)", async () => {
    const op = await makeOperator("stepup-lock");
    for (let i = 0; i < 10; i++) {
      const r = await fixtures.inject({
        method: "POST",
        url: "/api/v1/tenant/auth/passkeys/register/start",
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { password: `wrong-${i}` },
      });
      expect(r.statusCode).toBe(401);
    }
    const opSignIn = await fixtures.inject({
      method: "POST",
      url: "/api/v1/tenant/auth/sign-in",
      payload: { email: op.email, password: PASSWORD },
    });
    expect(opSignIn.statusCode).toBe(429);

    const { publicKey } = await makeApplication("rlh-stepup-lock");
    const token = await makeEndUser(publicKey, "stepup-lock@example.com");
    for (let i = 0; i < 10; i++) {
      const r = await fixtures.inject({
        method: "POST",
        url: "/api/v1/auth/passkey/register/start",
        headers: {
          authorization: `Bearer ${publicKey}`,
          "x-rekey-user-token": token,
        },
        payload: { password: `wrong-${i}` },
      });
      expect(r.statusCode).toBe(401);
    }
    const euSignIn = await fixtures.inject({
      method: "POST",
      url: "/api/v1/auth/sign-in",
      headers: { authorization: `Bearer ${publicKey}` },
      payload: {
        email: "stepup-lock@example.com",
        password: "correct-horse-battery",
      },
    });
    expect(euSignIn.statusCode).toBe(429);
    expect(euSignIn.json().error.code).toBe("TOO_MANY_FAILED_ATTEMPTS");
  });

  it("end user: ten wrong change-password attempts lock sign-in", async () => {
    const { publicKey } = await makeApplication("rlh-lock");
    const token = await makeEndUser(publicKey, "lock-user@example.com");
    for (let i = 0; i < 10; i++) {
      const r = await fixtures.inject({
        method: "POST",
        url: "/api/v1/auth/change-password",
        headers: {
          authorization: `Bearer ${publicKey}`,
          "x-rekey-user-token": token,
        },
        payload: {
          currentPassword: `wrong-${i}`,
          newPassword: "another-long-password-1",
        },
      });
      expect(r.statusCode).toBe(401);
    }
    const signIn = await fixtures.inject({
      method: "POST",
      url: "/api/v1/auth/sign-in",
      headers: { authorization: `Bearer ${publicKey}` },
      payload: {
        email: "lock-user@example.com",
        password: "correct-horse-battery",
      },
    });
    expect(signIn.statusCode).toBe(429);
    expect(signIn.json().error.code).toBe("TOO_MANY_FAILED_ATTEMPTS");
  });
});

describe("rejected credentials are counted per client IP", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await enforcedApp();
  });
  afterEach(async () => {
    await app?.close();
  });

  const forgedOperatorJwt = jwt.sign(
    { sub: "nobody", tid: "nowhere", typ: "tenant" },
    "not-the-secret",
  );
  const expiredOperatorJwt = jwt.sign(
    { sub: "nobody", tid: "nowhere", typ: "tenant" },
    process.env.JWT_SECRET!,
    { expiresIn: -60 },
  );

  it("garbage, forged, expired and fake-prefixed credentials get no budget and are cut off at 100", async () => {
    const ip = "203.0.113.200";
    const attempts: InjectOptions[] = [
      {
        method: "GET",
        url: "/api/v1/tenant/auth/me",
        headers: { authorization: "Bearer garbage" },
      },
      {
        method: "GET",
        url: "/api/v1/tenant/auth/me",
        headers: { authorization: `Bearer ${forgedOperatorJwt}` },
      },
      {
        method: "GET",
        url: "/api/v1/tenant/auth/me",
        headers: { authorization: `Bearer ${expiredOperatorJwt}` },
      },
      {
        method: "GET",
        url: "/api/v1/me/",
        headers: {
          authorization: "Bearer rp_live_000000000000000000000000000000",
        },
      },
      {
        method: "GET",
        url: "/api/v1/tenant/operator/applications",
        headers: {
          authorization: "Bearer rp_op_000000000000000000000000000000",
        },
      },
    ];
    for (let i = 0; i < 100; i++) {
      const r = await app.inject({
        ...attempts[i % attempts.length]!,
        remoteAddress: ip,
      });
      expect(r.statusCode).toBe(401);
      // Never the authenticated budget.
      expect(r.headers["x-ratelimit-limit"]).not.toBe("600");
      expect(r.headers["x-ratelimit-limit"]).not.toBe("30000");
    }
    const over = await app.inject({ ...attempts[0]!, remoteAddress: ip });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("RATE_LIMITED");
    // This address is the client's own (a direct connection), so blocking it
    // blocks only that client. A shared proxy address is never blocked, and a
    // verified secret key never is: test/rate-limit-proxy-trust.test.ts.
    // Another address is untouched.
    const elsewhere = await app.inject({
      ...attempts[0]!,
      remoteAddress: "203.0.113.201",
    });
    expect(elsewhere.statusCode).toBe(401);
  });

  it("behind a trusted panel, failures count per forwarded client, not per panel", async () => {
    await app.close();
    app = await enforcedApp("10.77.0.10");
    const viaPanel = (client: string): InjectOptions => ({
      method: "GET",
      url: "/api/v1/tenant/auth/me",
      remoteAddress: "10.77.0.10",
      headers: { authorization: "Bearer garbage", "x-forwarded-for": client },
    });
    await fire(app, 100, viaPanel("198.51.100.50"));
    expect((await app.inject(viaPanel("198.51.100.50"))).statusCode).toBe(429);
    expect((await app.inject(viaPanel("198.51.100.51"))).statusCode).toBe(401);
  });
});

describe("one address cannot farm authenticated budgets", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("end-user sign-up is capped at 10 per (Application, IP)", async () => {
    app = await enforcedApp();
    const { publicKey } = await makeApplication("rlh-signup");
    const signUp = (i: number, ip: string): InjectOptions => ({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      remoteAddress: ip,
      headers: { authorization: `Bearer ${publicKey}` },
      payload: {
        email: `farm-${ip}-${i}@example.com`,
        password: "correct-horse-battery",
      },
    });
    for (let i = 0; i < 10; i++)
      expect((await app.inject(signUp(i, "198.51.100.60"))).statusCode).toBe(
        201,
      );
    expect((await app.inject(signUp(10, "198.51.100.60"))).statusCode).toBe(
      429,
    );
    expect((await app.inject(signUp(0, "198.51.100.61"))).statusCode).toBe(201);
  });

  it("send-verification is capped at 10", async () => {
    app = await enforcedApp();
    const { publicKey } = await makeApplication("rlh-sendv");
    const token = await makeEndUser(publicKey, "sendv@example.com");
    const req: InjectOptions = {
      method: "POST",
      url: "/api/v1/auth/send-verification",
      remoteAddress: "198.51.100.62",
      headers: {
        authorization: `Bearer ${publicKey}`,
        "x-rekey-user-token": token,
      },
      payload: {},
    };
    const tries = await fire(app, 10, req);
    expect(tries.every((r) => r.statusCode !== 429)).toBe(true);
    expect((await app.inject(req)).statusCode).toBe(429);
  });

  it("many identities from one IP share a per-IP authenticated ceiling", async () => {
    app = await enforcedApp(undefined, {
      rateLimitOverrides: { authenticatedPerIp: 5 },
    });
    const ops = await Promise.all([
      makeOperator("ceil-1"),
      makeOperator("ceil-2"),
    ]);
    const me = (token: string, ip: string): InjectOptions => ({
      method: "GET",
      url: "/api/v1/tenant/auth/me",
      remoteAddress: ip,
      headers: { authorization: `Bearer ${token}` },
    });
    for (let i = 0; i < 5; i++) {
      expect(
        (await app.inject(me(ops[i % 2]!.accessToken, "198.51.100.70")))
          .statusCode,
      ).toBe(200);
    }
    // Neither identity is near its own 600, but the address is spent.
    const over = await app.inject(me(ops[1]!.accessToken, "198.51.100.70"));
    expect(over.statusCode).toBe(429);
    expect(
      (await app.inject(me(ops[1]!.accessToken, "198.51.100.71"))).statusCode,
    ).toBe(200);
  });

  it("a secret API key is not held to the per-IP authenticated ceiling", async () => {
    app = await enforcedApp(undefined, {
      rateLimitOverrides: { authenticatedPerIp: 5 },
    });
    const { secretKey } = await makeApplication("rlh-key-ceil");
    const req: InjectOptions = {
      method: "GET",
      url: "/api/v1/me/",
      remoteAddress: "198.51.100.72",
      headers: { authorization: `Bearer ${secretKey}` },
    };
    const tries = await fire(app, 8, req);
    expect(tries.every((r) => r.statusCode === 200)).toBe(true);
  });
});

describe("proxy trust on the shipped compose settings", () => {
  function composeDefault(file: string): string {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    const m = /^\s+TRUSTED_PROXIES:\s*(.+)$/m.exec(text);
    expect(m, `${file} sets TRUSTED_PROXIES`).not.toBeNull();
    // `${TRUSTED_PROXIES:-<default>}`, possibly with nested ${VAR:-x} inside.
    const raw = m![1]!.trim();
    return raw.replace(/^\$\{TRUSTED_PROXIES:-/, "").replace(/\}$/, "");
  }

  function resolveNested(value: string): string {
    return value.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, "$1");
  }

  it.each([
    "docker-compose.prod.yml",
    "docker-compose.yml",
  ])("%s never defaults to a hop count", (file) => {
    const value = resolveNested(composeDefault(file));
    expect(value).not.toMatch(/^\d+$/);
    if (value === "") return; // nothing trusted by address
    for (const entry of value.split(",")) {
      // Exact addresses only: no CIDR that would include a network gateway.
      expect(entry.trim()).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    }
  });

  it.each(["docker-compose.prod.yml"])(
    "%s has Traefik present API_PROXY_SECRET to the API",
    (file) => {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      expect(text).toMatch(/^\s+API_PROXY_SECRET: \$\{API_PROXY_SECRET[:?-]/m);
      expect(text).toMatch(
        /traefik\.http\.middlewares\.rekey-api-proxy-secret\.headers\.customrequestheaders\.X-Rekey-Proxy-Secret=\$\{API_PROXY_SECRET/,
      );
      expect(text).toContain(
        "traefik.http.routers.rekey-api.middlewares=rekey-api-proxy-secret",
      );
    },
  );

  it("on the prod default, a sibling container cannot forge its address", async () => {
    const trusted = resolveNested(composeDefault("docker-compose.prod.yml"));
    // A sibling on the shared network is not blocked by IP (its address may
    // be a proxy's), but it cannot choose the address the API sees either:
    // it cannot claim one on ADMIN_IP_ALLOWLIST.
    const prev = process.env.ADMIN_IP_ALLOWLIST;
    process.env.ADMIN_IP_ALLOWLIST = "192.0.2.1";
    const app = await enforcedApp(trusted, {
      apiProxy: { secret: "a-configured-proxy-secret-123", hops: 1 },
    });
    try {
      const forged = await app.inject({
        method: "GET",
        url: "/api/v1/admin/tenants",
        remoteAddress: "10.0.1.99",
        headers: {
          authorization: `Bearer ${ADMIN_KEY}`,
          "x-forwarded-for": "192.0.2.1",
        },
      });
      expect(forged.statusCode).toBe(403);
      // Unvouched, so the allowlist has no client address to check and says so.
      expect(forged.json().error.code).toBe("ADMIN_IP_UNVERIFIABLE");
    } finally {
      await app.close();
      if (prev === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
      else process.env.ADMIN_IP_ALLOWLIST = prev;
    }
  });

  it("portal topology: many visitors through the trusted portal get their own buckets", async () => {
    const trusted = resolveNested(composeDefault("docker-compose.prod.yml"));
    const portalIp = trusted.split(",")[1]!.trim();
    const app = await enforcedApp(trusted);
    try {
      const config = (client: string, slug: string): InjectOptions => ({
        method: "GET",
        url: `/api/v1/portal/config/${slug}`,
        remoteAddress: portalIp,
        headers: { "x-forwarded-for": client },
      });
      // 150 visitors, one page load each, all arriving from the portal: the
      // old per-peer keying capped the whole portal at 100.
      for (let i = 0; i < 150; i++) {
        const r = await app.inject(config(`198.51.100.${i}`, "some-app"));
        expect(r.statusCode).toBe(404);
      }
      // One visitor hammering is still capped on their own.
      await fire(app, 30, config("203.0.113.9", "some-app"));
      expect(
        (await app.inject(config("203.0.113.9", "some-app"))).statusCode,
      ).toBe(429);
    } finally {
      await app.close();
    }
  });
});
