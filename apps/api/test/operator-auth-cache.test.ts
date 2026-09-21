/**
 * The operator auth cache must never outlive a revocation.
 *
 * `lib/operator-auth-cache.ts` serves the operator row, session liveness,
 * membership and grants from memory. Every test here first WARMS the cache
 * (and proves a warm request costs no query, so the cache really is what
 * answers), then performs a write through the API and asserts the very next
 * request is refused.
 *
 * "Process B" is a second copy of the whole module graph (`vi.resetModules`
 * then a fresh `buildApp`), with its own caches, joined to process A only by
 * an in-memory pub/sub bus that stands in for Redis. That is what a second
 * API replica is: same database, separate memory, one channel between them.
 *
 * HOW "COSTS NO QUERY" IS MEASURED
 *
 * Not with `test/query-counter.ts`. That records Prisma's `query` LOG EVENTS
 * between two points in wall-clock time, over a client both processes share
 * (lib/prisma.ts keeps it on globalThis, so `vi.resetModules()` hands process B
 * the same one) and which outlives this file in the single-fork worker. A
 * window therefore also collects statements this request never issued.
 *
 * That is what flaked here: on a loaded runner with coverage on, a window whose
 * request was served entirely from cache collected one `tenant_memberships`
 * SELECT, the third and last statement of the request BEFORE it, reported
 * after that request had already been awaited and the window opened. Whether
 * the engine delivered the log event late (it is pushed on a channel of its
 * own, not ordered against the promise the caller awaits) or something else in
 * the worker issued it, a window cannot tell, because it attributes by clock.
 *
 * `authReads` below attributes each read to the request that ISSUED it: the
 * four auth reads are wrapped once, each call is tagged with the
 * AsyncLocalStorage scope it was made in, and only the scope under measurement
 * counts. It is strictly narrower than a query window, and it is the assertion
 * these tests actually depend on ("this request read no auth rows"), not
 * "nothing in this process ran a query just now".
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import * as cacheA from '../src/lib/operator-auth-cache.js';
import { hashTenantRefreshToken } from '../src/lib/tenant-refresh-tokens.js';
import { tenantAuthService } from '../src/modules/tenant-auth/tenant-auth.service.js';

/**
 * The reads the operator auth cache exists to remove. `requireTenantSession`
 * makes the first three (middleware/tenant-session.ts), `resolveGrantSet` the
 * fourth (lib/access-context.ts).
 */
const AUTH_READS = [
  ['tenantUser', 'findUnique'],
  ['tenantRefreshToken', 'findFirst'],
  ['tenantMembership', 'findUnique'],
  ['applicationGrant', 'findMany'],
] as const;

const readScope = new AsyncLocalStorage<string[]>();

/**
 * Wrap the auth reads so each call lands in the scope that made it. Returns the
 * undo: a Prisma model delegate is a Proxy that produces its methods on read,
 * so the real method is captured once here and written back verbatim, never
 * deleted (see the header of organization-role-cache-pubsub.test.ts).
 */
function watchAuthReads(): () => void {
  const undo = AUTH_READS.map(([model, method]) => {
    const delegate = prisma[model] as unknown as Record<string, unknown>;
    const original = delegate[method] as (...a: unknown[]) => Promise<unknown>;
    delegate[method] = (...args: unknown[]) => {
      readScope.getStore()?.push(`${model}.${method}`);
      return original.apply(prisma[model], args);
    };
    return () => {
      delegate[method] = original;
    };
  });
  return () => undo.forEach((f) => f());
}

/** The auth reads `fn` issued, in order. */
async function authReads(fn: () => Promise<unknown>): Promise<string[]> {
  const reads: string[] = [];
  await readScope.run(reads, fn);
  return reads;
}

/**
 * Let the wrapped Prisma method run, then hold its RESULT until released, for
 * the first call `match` accepts. That is the window a race needs: the rows
 * are read, the write and its invalidation land, then the load tries to store.
 */
function holdAfterRead<T extends object>(
  delegate: T,
  method: keyof T & string,
  match: (arg: { where?: Record<string, unknown> } | undefined) => boolean,
) {
  const d = delegate as Record<string, unknown>;
  const original = d[method] as (...a: unknown[]) => Promise<unknown>;
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  const releaseP = new Promise<void>((r) => (release = r));
  let used = false;
  d[method] = async (...args: unknown[]) => {
    const result = await original.apply(delegate, args);
    if (!used && match(args[0] as { where?: Record<string, unknown> } | undefined)) {
      used = true;
      reached();
      await releaseP;
    }
    return result;
  };
  return {
    reached: reachedP,
    release,
    restore: () => {
      d[method] = original;
    },
  };
}

type CacheModule = typeof import('../src/lib/operator-auth-cache.js');

/** A Redis stand-in: publish fans out to every subscriber, asynchronously. */
class FakeSubscriber extends EventEmitter {
  channels = new Set<string>();
  constructor(
    private readonly bus: FakeBus,
    public connected: boolean,
  ) {
    super();
  }
  /** Like ioredis with the offline queue off: refused until connected. */
  subscribe(channel: string): Promise<number> {
    if (!this.connected) return Promise.reject(new Error("Stream isn't writeable"));
    this.channels.add(channel);
    return Promise.resolve(1);
  }
  connect(): void {
    this.connected = true;
    this.emit('ready');
  }
  quit(): Promise<string> {
    this.bus.subscribers.delete(this);
    this.emit('end');
    return Promise.resolve('OK');
  }
}

class FakeBus {
  constructor(private readonly startConnected = true) {}
  subscribers = new Set<FakeSubscriber>();
  /** When true, publishes vanish: a Redis blip between writer and readers. */
  drop = false;
  published: string[] = [];
  /** Publishes still to refuse, like the shared client during a reconnect. */
  failNext = 0;
  publish(channel: string, message: string): Promise<number> {
    this.published.push(message);
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
    }
    if (!this.drop) {
      for (const s of this.subscribers) {
        if (s.channels.has(channel)) setImmediate(() => s.emit('message', channel, message));
      }
    }
    return Promise.resolve(this.subscribers.size);
  }
  duplicate(): FakeSubscriber {
    const s = new FakeSubscriber(this, this.startConnected);
    this.subscribers.add(s);
    return s;
  }
}

/** Let queued pub/sub deliveries run. */
const delivered = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('operator auth cache: revocation stays immediate', () => {
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let cacheB: CacheModule;
  let bus: FakeBus;
  let n = 0;
  let ip = '10.88.0.1';
  let unwatch: () => void = () => undefined;

  beforeAll(async () => {
    unwatch = watchAuthReads();
    appA = await buildApp({ logger: false });
    await appA.ready();
    vi.resetModules();
    const modB = (await import('../src/app.js')) as typeof import('../src/app.js');
    cacheB = (await import('../src/lib/operator-auth-cache.js')) as CacheModule;
    appB = await modB.buildApp({ logger: false });
    await appB.ready();
  }, 120_000);

  afterAll(async () => {
    cacheA.__usePubSubForTests(undefined);
    cacheB.__usePubSubForTests(undefined);
    await appA.close();
    await appB.close();
    // The client is shared with every later file in this worker.
    unwatch();
    expect(await prisma.tenantUser.findUnique({ where: { id: 'no-such-operator' } })).toBeNull();
  });

  beforeEach(() => {
    bus = new FakeBus();
    cacheA.__usePubSubForTests(bus);
    cacheB.__usePubSubForTests(bus);
    ip = `10.88.${++n}.1`;
  });

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  function on(app: FastifyInstance, opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: ip, ...opts } as never);
  }
  const probe = (app: FastifyInstance, token: string) =>
    on(app, { method: 'GET', url: '/api/v1/tenant/workspace/creation-mode', headers: auth(token) });

  interface Session {
    accessToken: string;
    refreshToken: string;
  }

  async function signUp(tag: string): Promise<Session & { email: string }> {
    const email = `op-${tag}@example.com`;
    const r = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName: `WS ${tag}` },
    });
    expect(r.statusCode).toBe(201);
    return { ...(r.json().data as Session), email };
  }

  async function signIn(email: string): Promise<Session> {
    const r = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(r.statusCode).toBe(200);
    return r.json().data as Session;
  }

  /**
   * Admitted requests until one is served without an auth read. The first
   * request after a process boots only starts the subscription and is never
   * cached; the one after it loads and stores. Three is the most it may take.
   */
  async function warm(app: FastifyInstance, token: string): Promise<void> {
    expect((await probe(app, token)).statusCode).toBe(200);
    await delivered();
    expect((await probe(app, token)).statusCode).toBe(200);
    const third = await authReads(async () => {
      expect((await probe(app, token)).statusCode).toBe(200);
    });
    expect(third, third.join(', ')).toEqual([]);
  }

  const tag = () => `${n}-${Math.random().toString(36).slice(2, 7)}`;

  // ---------------------------------------------------------------- one process

  it('sign out everywhere: the next request from any session is refused', async () => {
    const s = await signUp(`rall-${tag()}`);
    await warm(appA, s.accessToken);
    const r = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-out-everywhere',
      headers: auth(s.accessToken),
    });
    expect(r.statusCode).toBe(200);
    const after = await probe(appA, s.accessToken);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('TENANT_SESSION_INVALID');
  });

  it('single-session revoke: that session is refused at once, the other is not', async () => {
    const s = await signUp(`rone-${tag()}`);
    const one = await signIn(s.email);
    const two = await signIn(s.email);
    await warm(appA, one.accessToken);
    await warm(appA, two.accessToken);
    const row = await prisma.tenantRefreshToken.findUniqueOrThrow({
      where: { tokenHash: hashTenantRefreshToken(one.refreshToken) },
    });
    const r = await on(appA, {
      method: 'DELETE',
      url: `/api/v1/tenant/auth/sessions/${row.id}`,
      headers: auth(two.accessToken),
    });
    expect(r.statusCode).toBe(200);
    expect((await probe(appA, one.accessToken)).statusCode).toBe(401);
    expect((await probe(appA, two.accessToken)).statusCode).toBe(200);
  });

  it('sign-out: the signed-out session is refused at once', async () => {
    const s = await signUp(`sout-${tag()}`);
    await warm(appA, s.accessToken);
    const r = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-out',
      payload: { refreshToken: s.refreshToken },
    });
    expect(r.statusCode).toBeLessThan(300);
    expect((await probe(appA, s.accessToken)).statusCode).toBe(401);
  });

  it('password change: every session is refused at once', async () => {
    const s = await signUp(`pw-${tag()}`);
    const other = await signIn(s.email);
    await warm(appA, s.accessToken);
    await warm(appA, other.accessToken);
    const r = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/auth/change-password',
      headers: auth(s.accessToken),
      payload: { currentPassword: 'pw-one-two-three', newPassword: 'a-new-long-passphrase-9' },
    });
    expect(r.statusCode).toBe(200);
    expect((await probe(appA, s.accessToken)).statusCode).toBe(401);
    expect((await probe(appA, other.accessToken)).statusCode).toBe(401);
  });

  /** Owner, an invited member with APP_ADMIN on one app, and the membership id. */
  async function workspaceWithMember(role: 'ADMIN' | 'MEMBER') {
    const t = tag();
    const owner = await signUp(`own-${t}`);
    const invitee = await signUp(`mem-${t}`);
    const app = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: auth(owner.accessToken),
      payload: { name: `App ${t}`, slug: `ac-${t}` },
    });
    expect(app.statusCode).toBe(201);
    const appId = (app.json().data as { id: string }).id;
    const inv = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: auth(owner.accessToken),
      payload: { email: invitee.email, role },
    });
    const accept = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(invitee.accessToken),
      payload: { token: (inv.json().data as { token: string }).token },
    });
    expect(accept.statusCode).toBe(200);
    const member = (accept.json().data as { accessToken: string }).accessToken;
    const membership = await prisma.tenantMembership.findFirstOrThrow({
      where: { tenantUser: { email: invitee.email }, role, tenant: { applications: { some: { id: appId } } } },
    });
    if (role === 'MEMBER') {
      const g = await on(appA, {
        method: 'PUT',
        url: `/api/v1/tenant/workspace/members/${membership.id}/grants`,
        headers: auth(owner.accessToken),
        payload: { applicationId: appId, role: 'APP_ADMIN' },
      });
      expect(g.statusCode).toBe(200);
    }
    return { owner: owner.accessToken, member, membershipId: membership.id, appId };
  }

  const activeRole = async (app: FastifyInstance, token: string) => {
    const r = await on(app, { method: 'GET', url: '/api/v1/tenant/auth/me', headers: auth(token) });
    expect(r.statusCode).toBe(200);
    return (r.json().data as { activeRole: string }).activeRole;
  };

  it('role downgrade takes effect on the next request', async () => {
    const w = await workspaceWithMember('ADMIN');
    await warm(appA, w.member);
    expect(await activeRole(appA, w.member)).toBe('ADMIN');
    const r = await on(appA, {
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.owner),
      payload: { role: 'MEMBER' },
    });
    expect(r.statusCode).toBe(200);
    expect(await activeRole(appA, w.member)).toBe('MEMBER');
  });

  it('member removal is refused on the next request', async () => {
    const w = await workspaceWithMember('ADMIN');
    await warm(appA, w.member);
    const r = await on(appA, {
      method: 'DELETE',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.owner),
    });
    expect(r.statusCode).toBeLessThan(300);
    const after = await probe(appA, w.member);
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('TENANT_MEMBERSHIP_REVOKED');
  });

  it('grant removal, grant downgrade and scope restriction take effect at once', async () => {
    const w = await workspaceWithMember('MEMBER');
    const keys = `/api/v1/tenant/applications/${w.appId}/api-keys`;
    const getKeys = () => on(appA, { method: 'GET', url: keys, headers: auth(w.member) });
    expect((await getKeys()).statusCode).toBe(200);
    const warmRead = await authReads(async () => expect((await getKeys()).statusCode).toBe(200));
    // Auth, grants and the app mapping all cached: only the handler's own read.
    expect(warmRead, warmRead.join(', ')).toEqual([]);

    // Scopes: restrict to nothing, the scoped route is refused.
    const scoped = await on(appA, {
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.owner),
      payload: { scopes: [] },
    });
    expect(scoped.statusCode).toBe(200);
    const refusedScope = await getKeys();
    expect(refusedScope.statusCode).toBe(403);
    expect(refusedScope.json().error.code).toBe('SCOPE_INSUFFICIENT');
    await on(appA, {
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.owner),
      payload: { scopes: null },
    });
    expect((await getKeys()).statusCode).toBe(200);

    // Grant downgrade: APP_VIEWER may not write.
    await on(appA, {
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}/grants`,
      headers: auth(w.owner),
      payload: { applicationId: w.appId, role: 'APP_VIEWER' },
    });
    const write = await on(appA, {
      method: 'POST',
      url: keys,
      headers: auth(w.member),
      payload: { name: 'k', mode: 'live' },
    });
    expect(write.statusCode).toBe(403);

    // Grant removal: the application disappears.
    const del = await on(appA, {
      method: 'DELETE',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}/grants/${w.appId}`,
      headers: auth(w.owner),
    });
    expect(del.statusCode).toBeLessThan(300);
    expect((await getKeys()).statusCode).toBe(404);
  });

  it('a grant removed while a grant read is in flight is not cached back', async () => {
    const w = await workspaceWithMember('MEMBER');
    const keys = `/api/v1/tenant/applications/${w.appId}/api-keys`;
    const getKeys = () => on(appA, { method: 'GET', url: keys, headers: auth(w.member) });
    await warm(appA, w.member);
    const hold = holdAfterRead(
      prisma.applicationGrant,
      'findMany',
      (arg) => arg?.where?.tenantMembershipId === w.membershipId,
    );
    try {
      const inFlight = getKeys();
      await hold.reached; // the grant has been read, not yet stored
      const del = await on(appA, {
        method: 'DELETE',
        url: `/api/v1/tenant/workspace/members/${w.membershipId}/grants/${w.appId}`,
        headers: auth(w.owner),
      });
      expect(del.statusCode).toBeLessThan(300);
      hold.release();
      // Admitted on the rows it read before the delete committed, as it
      // would have been with no cache at all.
      expect((await inFlight).statusCode).toBe(200);
    } finally {
      hold.restore();
    }
    expect((await getKeys()).statusCode).toBe(404);
  });

  it('a role downgrade while an auth read is in flight is not cached back', async () => {
    const w = await workspaceWithMember('ADMIN');
    await warm(appA, w.owner);
    const { tenantUserId } = await prisma.tenantMembership.findUniqueOrThrow({
      where: { id: w.membershipId },
    });
    cacheA.invalidateOperatorAuth(tenantUserId);
    const hold = holdAfterRead(
      prisma.tenantMembership,
      'findUnique',
      (arg) =>
        (arg?.where?.tenantUserId_tenantId as { tenantUserId?: string } | undefined)?.tenantUserId ===
        tenantUserId,
    );
    try {
      const inFlight = probe(appA, w.member);
      await hold.reached; // membership read as ADMIN, not yet stored
      const r = await on(appA, {
        method: 'PATCH',
        url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
        headers: auth(w.owner),
        payload: { role: 'MEMBER' },
      });
      expect(r.statusCode).toBe(200);
      hold.release();
      expect((await inFlight).statusCode).toBe(200);
    } finally {
      hold.restore();
    }
    expect(await activeRole(appA, w.member)).toBe('MEMBER');
  });

  it('the OAuth email-verified upgrade drops the cached operator row', async () => {
    const s = await signUp(`oauth-${tag()}`);
    await prisma.tenantUser.update({ where: { email: s.email }, data: { emailVerified: false } });
    await warm(appA, s.accessToken);
    await tenantAuthService.findOrCreateOAuthOperator({ email: s.email, emailVerified: true });
    const after = await authReads(async () => {
      expect((await probe(appA, s.accessToken)).statusCode).toBe(200);
    });
    expect(after).toContain('tenantUser.findUnique');
  });

  // ------------------------------------------------------------- two processes

  it('revoke-all in process A is refused in process B after the pub/sub message', async () => {
    const s = await signUp(`xall-${tag()}`);
    await warm(appB, s.accessToken);
    const r = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-out-everywhere',
      headers: auth(s.accessToken),
    });
    expect(r.statusCode).toBe(200);
    expect((await probe(appA, s.accessToken)).statusCode).toBe(401);
    await delivered();
    expect((await probe(appB, s.accessToken)).statusCode).toBe(401);
  });

  it('single-session revoke in A is refused in B after the message', async () => {
    const s = await signUp(`xone-${tag()}`);
    const one = await signIn(s.email);
    const two = await signIn(s.email);
    await warm(appB, one.accessToken);
    await warm(appB, two.accessToken);
    const row = await prisma.tenantRefreshToken.findUniqueOrThrow({
      where: { tokenHash: hashTenantRefreshToken(one.refreshToken) },
    });
    const r = await on(appA, {
      method: 'DELETE',
      url: `/api/v1/tenant/auth/sessions/${row.id}`,
      headers: auth(two.accessToken),
    });
    expect(r.statusCode).toBe(200);
    await delivered();
    expect((await probe(appB, one.accessToken)).statusCode).toBe(401);
    expect((await probe(appB, two.accessToken)).statusCode).toBe(200);
  });

  it('role downgrade in A takes effect in B after the message', async () => {
    const w = await workspaceWithMember('ADMIN');
    await warm(appB, w.member);
    expect(await activeRole(appB, w.member)).toBe('ADMIN');
    const r = await on(appA, {
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.owner),
      payload: { role: 'MEMBER' },
    });
    expect(r.statusCode).toBe(200);
    await delivered();
    expect(await activeRole(appB, w.member)).toBe('MEMBER');
  });

  it('a failed publish is logged and retried once, and the retry reaches B', async () => {
    const s = await signUp(`retry-${tag()}`);
    await warm(appB, s.accessToken);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      bus.failNext = 1;
      const r = await on(appA, {
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-out-everywhere',
        headers: auth(s.accessToken),
      });
      expect(r.statusCode).toBe(200);
      await delivered();
      // The first publish was refused, so B has not heard yet.
      expect((await probe(appB, s.accessToken)).statusCode).toBe(200);
      await new Promise((res) => setTimeout(res, cacheA.PUBLISH_RETRY_MS + 100));
      expect((await probe(appB, s.accessToken)).statusCode).toBe(401);
      const logged = warn.mock.calls.map((c) => String(c[0]));
      expect(logged.some((m) => /publish .* failed .*retrying/.test(m))).toBe(true);
      // The log names no operator.
      const { id } = await prisma.tenantUser.findUniqueOrThrow({ where: { email: s.email } });
      expect(logged.some((m) => m.includes(id))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('a LOST message leaves B stale for at most the TTL, never longer', async () => {
    const s = await signUp(`drop-${tag()}`);
    await warm(appB, s.accessToken);
    bus.drop = true;
    const r = await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-out-everywhere',
      headers: auth(s.accessToken),
    });
    expect(r.statusCode).toBe(200);
    await delivered();
    // This is the residual staleness the PR documents: B never heard.
    expect((await probe(appB, s.accessToken)).statusCode).toBe(200);
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 5_001);
    try {
      expect((await probe(appB, s.accessToken)).statusCode).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });

  it('a subscriber disconnect stops B serving from cache until it is back', async () => {
    const s = await signUp(`disc-${tag()}`);
    await warm(appB, s.accessToken);
    // Redis drops both processes' subscriber connections.
    for (const sub of [...bus.subscribers]) sub.emit('close');
    const offline = await authReads(async () => {
      expect((await probe(appB, s.accessToken)).statusCode).toBe(200);
    });
    expect(offline).toContain('tenantMembership.findUnique');
    for (const sub of [...bus.subscribers]) sub.emit('ready');
    // A confirmed subscription empties the cache and only then serves from it.
    // Warming before that point races the emptying, which discards the load.
    await vi.waitFor(() => expect(cacheB.__isServingFromCacheForTests()).toBe(true));
    await warm(appB, s.accessToken);
  });

  it('serves nothing from cache until the subscription is confirmed, then invalidates across processes', async () => {
    // A fresh ioredis duplicate is still connecting when it is created, and
    // with the offline queue off it refuses SUBSCRIBE until it is up.
    const slow = new FakeBus(false);
    cacheB.__usePubSubForTests(slow);
    cacheA.__usePubSubForTests(slow);
    const s = await signUp(`slow-${tag()}`);
    for (let i = 0; i < 3; i++) expect((await probe(appB, s.accessToken)).statusCode).toBe(200);
    const unconfirmed = await authReads(async () => {
      expect((await probe(appB, s.accessToken)).statusCode).toBe(200);
    });
    expect(unconfirmed).toContain('tenantMembership.findUnique');

    for (const sub of [...slow.subscribers]) sub.connect();
    await delivered();
    await warm(appB, s.accessToken);
    await on(appA, {
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-out-everywhere',
      headers: auth(s.accessToken),
    });
    await delivered();
    expect((await probe(appB, s.accessToken)).statusCode).toBe(401);
  });

  // --------------------------------------------------------------- unit level

  it('a load that raced an invalidation is not stored', async () => {
    cacheA.getCachedAuth('boot', 'boot', undefined); // start the subscription
    await delivered();
    const entry = {
      user: {} as never,
      membership: { id: 'm1', role: 'OWNER' as const, scopesRestricted: false, scopes: [] },
    };
    const ticket = cacheA.loadTicket();
    cacheA.invalidateOperatorAuth('op-1');
    cacheA.storeAuth(ticket, 'op-1', 't1', 's1', entry);
    expect(cacheA.getCachedAuth('op-1', 't1', 's1')).toBeNull();

    const fresh = cacheA.loadTicket();
    cacheA.storeAuth(fresh, 'op-1', 't1', 's1', entry);
    expect(cacheA.getCachedAuth('op-1', 't1', 's1')).not.toBeNull();
    // An invalidation for a different operator's membership leaves it alone,
    // one for this membership drops it.
    cacheA.applyInvalidation('o:op-2 m:m2');
    expect(cacheA.getCachedAuth('op-1', 't1', 's1')).not.toBeNull();
    cacheA.applyInvalidation('m:m1');
    expect(cacheA.getCachedAuth('op-1', 't1', 's1')).toBeNull();
  });
});
