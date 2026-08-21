/**
 * Application lifecycle — promotion to production, and the disable switch.
 * Spec: docs/specs/app-lifecycle.md
 *
 * The invariant every quota assertion here defends, stated once:
 *
 *   The number of Applications with `environment: PRODUCTION` and
 *   `disabledAt: null` must never exceed `maxProductionApps`.
 *
 * Note what that is NOT: a ceiling on lifetime promotions, or on rows whose
 * environment is PRODUCTION. A workspace may legitimately own more PRODUCTION
 * rows than its ceiling as long as all but `maxProductionApps` are disabled.
 * Two tests below assert exactly that, because it is the behaviour most likely
 * to be "fixed" by someone who reads the quota as a count of production rows.
 *
 * The three doors into the count are `create`, `promote` and `enable`. Every
 * one of them must assert. `disable` frees a slot and must never be refused.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const PASSWORD = 'correct-horse-battery';
const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('Application lifecycle', () => {
  let app: FastifyInstance;
  let operator: string;
  let tenantId: string;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    n += 1;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `lifecycle-${n}@example.com`,
        password: PASSWORD,
        workspaceName: `Lifecycle ${n}`,
      },
    });
    operator = (res.json().data as { accessToken: string }).accessToken;

    // The sign-up response carries the token, not the workspace. Read the
    // tenant id from the membership the sign-up just created — the same route
    // other suites use, rather than asserting a response shape this feature
    // does not own.
    const membership = await prisma.tenantMembership.findFirstOrThrow({
      where: { tenantUser: { email: `lifecycle-${n}@example.com` } },
      select: { tenantId: true },
    });
    tenantId = membership.tenantId;
  });

  const auth = () => ({ authorization: `Bearer ${operator}` });

  const createApp = (slug: string, body: Record<string, unknown> = {}) =>
    app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: slug, slug: `${slug}-${n}`, ...body },
      })
      .then((r) => r.json().data as { id: string; environment: string });

  const promote = (id: string) =>
    app.inject({ method: 'POST', url: `/api/v1/tenant/applications/${id}/promote`, headers: auth() });

  const disable = (id: string, reason?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${id}/disable`,
      headers: auth(),
      payload: reason === undefined ? {} : { reason },
    });

  const enable = (id: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/tenant/applications/${id}/disable`, headers: auth() });

  const setLimits = (limits: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/admin/tenants/${tenantId}/limits`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: limits,
    });

  const readLimits = () =>
    app.inject({ method: 'GET', url: '/api/v1/tenant/workspace/limits', headers: auth() });

  /**
   * A second operator who is a full ADMIN of the SAME workspace.
   *
   * The point of the role tests below is not "a stranger is refused" — that is
   * the cross-tenant matrix's job. It is that someone with real, legitimate,
   * far-reaching authority over this exact workspace is still refused these
   * three routes specifically.
   */
  async function adminOfSameWorkspace(): Promise<string> {
    const email = `lifecycle-admin-${n}@example.com`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: PASSWORD, workspaceName: `Other ${n}` },
    });
    expect(signUp.statusCode).toBe(201);
    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { email } });
    await prisma.tenantMembership.create({
      data: { tenantUserId: user.id, tenantId, role: 'ADMIN' },
    });
    // Re-issue against the workspace under test — the sign-up token carries
    // their OWN workspace in `tid`, not this one.
    const switched = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/switch-workspace',
      headers: { authorization: `Bearer ${(signUp.json().data as { accessToken: string }).accessToken}` },
      payload: { tenantId },
    });
    expect(switched.statusCode).toBe(200);
    return (switched.json().data as { accessToken: string }).accessToken;
  }

  const mintKey = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${id}/api-keys`,
      headers: auth(),
      payload: { name: 'k' },
    });

  // ---------------------------------------------------------------- promote

  describe('promote', () => {
    it('moves DEVELOPMENT to PRODUCTION and records who and when', async () => {
      const a = await createApp('promo-dev');
      expect(a.environment).toBe('DEVELOPMENT');

      const res = await promote(a.id);
      expect(res.statusCode).toBe(200);
      expect((res.json().data as { environment: string }).environment).toBe('PRODUCTION');

      const row = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.promotedAt).toBeInstanceOf(Date);
      // The audit breadcrumb must name a real operator, not just be non-null.
      expect(row.promotedBy).toBeTruthy();
    });

    it('promotes STAGING too — it is not a development-only path', async () => {
      const a = await createApp('promo-stage', { environment: 'STAGING' });
      expect((await promote(a.id)).statusCode).toBe(200);
    });

    it('is once-only: a second promote is 409 ALREADY_PROMOTED', async () => {
      const a = await createApp('promo-twice');
      expect((await promote(a.id)).statusCode).toBe(200);

      const second = await promote(a.id);
      expect(second.statusCode).toBe(409);
      expect((second.json().error as { code: string }).code).toBe('ALREADY_PROMOTED');
    });

    it('refuses an app created PRODUCTION — it is already there', async () => {
      const a = await createApp('promo-born-prod', { environment: 'PRODUCTION' });
      const res = await promote(a.id);
      expect(res.statusCode).toBe(409);
      // `promotedAt` stays null: born production is not the same event as
      // promoted, and nothing may forge the breadcrumb.
      const row = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.promotedAt).toBeNull();
    });

    it('does not touch existing API keys, and they keep authenticating', async () => {
      const a = await createApp('promo-keys');
      const minted = await mintKey(a.id);
      const rawKey = (minted.json().data as { rawKey: string }).rawKey;
      expect(rawKey).toMatch(/^rp_test_/);

      expect((await promote(a.id)).statusCode).toBe(200);

      // The prefix is a label, not a capability. Revoking these on promotion
      // would break a customer's integration at the exact moment they go live.
      const stillWorks = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(stillWorks.statusCode).toBe(200);

      // And a key minted AFTER the promotion carries the live prefix.
      const after = await mintKey(a.id);
      expect((after.json().data as { rawKey: string }).rawKey).toMatch(/^rp_live_/);
    });

    it('refuses to promote a disabled application', async () => {
      const a = await createApp('promo-disabled');
      expect((await disable(a.id)).statusCode).toBe(200);

      const res = await promote(a.id);
      expect(res.statusCode).toBe(409);
      expect((res.json().error as { code: string }).code).toBe('APPLICATION_DISABLED');

      // Refused means unchanged, not half-applied.
      const row = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.environment).toBe('DEVELOPMENT');
    });

    it('asserts the production quota, and leaves the row untouched when refused', async () => {
      await setLimits({ maxProductionApps: 1 });
      await createApp('quota-holder', { environment: 'PRODUCTION' });
      const candidate = await createApp('quota-candidate');

      const res = await promote(candidate.id);
      expect(res.statusCode).toBe(403);
      expect((res.json().error as { code: string }).code).toBe('TENANT_QUOTA_EXCEEDED');

      const row = await prisma.application.findUniqueOrThrow({ where: { id: candidate.id } });
      expect(row.environment).toBe('DEVELOPMENT');
      expect(row.promotedAt).toBeNull();
    });

    it('names the applications holding the slots, so the refusal is actionable', async () => {
      await setLimits({ maxProductionApps: 1 });
      const holder = await createApp('slot-holder', { environment: 'PRODUCTION' });
      const holderRow = await prisma.application.findUniqueOrThrow({ where: { id: holder.id } });
      const candidate = await createApp('slot-candidate');

      const res = await promote(candidate.id);
      const err = res.json().error as { message: string; fix: string };
      expect(err.message).toContain(holderRow.slug);
      // The remedy an operator can actually act on, on this door.
      expect(err.fix).toContain('Disable');
    });

    // Eight racers, not two. Two `app.inject` calls under Promise.all do not
    // reliably overlap inside the database — the first transaction often
    // commits before the second one counts, so the check-then-act window never
    // opens and the test passes with the advisory lock DELETED. That is a test
    // that proves nothing. Eight racers against one slot opens the window
    // reliably: verified by removing `lockWorkspaceSlots` from `promote` and
    // confirming this fails (multiple winners), then restoring it.
    it('concurrent promotions cannot both win the last slot', async () => {
      await setLimits({ maxProductionApps: 1 });
      const racers = await Promise.all(
        Array.from({ length: 8 }, (_, i) => createApp(`race-${i}`)),
      );

      const results = await Promise.all(racers.map((r) => promote(r.id)));
      const winners = results.filter((r) => r.statusCode === 200);
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 403)).toHaveLength(7);

      // The assertion that matters. There is no demote, so an overshoot here
      // would leave the workspace permanently over its ceiling with nothing
      // that ever brings it back.
      const running = await prisma.application.count({
        where: { tenantId, environment: 'PRODUCTION', disabledAt: null },
      });
      expect(running).toBe(1);
    });

    it('double-clicking promote on ONE app cannot double-write', async () => {
      const a = await createApp('race-same');
      const [r1, r2] = await Promise.all([promote(a.id), promote(a.id)]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    });
  });

  // ---------------------------------------------------------------- disable

  describe('disable', () => {
    it('records when, who and why', async () => {
      const a = await createApp('dis-basic');
      expect((await disable(a.id, 'sunset Q3')).statusCode).toBe(200);

      const row = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.disabledAt).toBeInstanceOf(Date);
      expect(row.disabledReason).toBe('sunset Q3');
      expect(row.disabledBy).toBeTruthy();
    });

    it('refuses end-user traffic on both the secret and publishable surfaces', async () => {
      const a = await createApp('dis-traffic');
      const rawKey = (await mintKey(a.id).then((r) => r.json().data as { rawKey: string })).rawKey;
      const pub = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });

      await disable(a.id);

      const secret = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(secret.statusCode).toBe(403);
      expect((secret.json().error as { code: string }).code).toBe('APPLICATION_DISABLED');

      // The publishable surface is the browser's door and has its own gate;
      // one middleware answering correctly proves nothing about the other.
      const publishable = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${pub.publicKey}` },
        payload: { email: 'nobody@example.com', password: PASSWORD },
      });
      expect(publishable.statusCode).toBe(403);
      expect((publishable.json().error as { code: string }).code).toBe('APPLICATION_DISABLED');
    });

    it('refuses a token minted BEFORE the freeze on the keyless /auth/me route', async () => {
      // `userTokenMeRoutes` is registered as its own plugin with no API-key
      // hook, so it does not inherit the freeze check the two key middlewares
      // perform. It was the one end-user route a disabled Application still
      // answered: sign-in and refresh were refused, and a token minted before
      // the freeze kept returning the holder's full record until it expired.
      //
      // It matters more than that window suggests. `disable` justifies NOT
      // bumping `tokenGeneration` on the grounds that existing tokens stop
      // working anyway "because both API-key middlewares refuse the Application
      // at the door". That is the reasoning which makes the freeze safe, and it
      // was false for this door.
      const a = await createApp('dis-me');
      const pub = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });

      const signUp = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${pub.publicKey}` },
        payload: { email: `me-${a.id}@example.com`, password: PASSWORD },
      });
      expect(signUp.statusCode).toBe(201);
      const accessToken = (signUp.json().data as { accessToken: string }).accessToken;

      // Live, the route answers. Asserted so the negative below cannot pass
      // because the request was malformed.
      const before = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { 'x-rekey-user-token': accessToken },
      });
      expect(before.statusCode).toBe(200);

      await disable(a.id);

      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { 'x-rekey-user-token': accessToken },
      });
      expect(after.statusCode).toBe(403);
      expect((after.json().error as { code: string }).code).toBe('APPLICATION_DISABLED');
    });

    it('leaves every operator surface open, or the freeze could not be undone', async () => {
      const a = await createApp('dis-operator');
      await disable(a.id);

      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${a.id}`,
        headers: auth(),
      });
      expect(read.statusCode).toBe(200);

      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/applications',
        headers: auth(),
      });
      expect(list.statusCode).toBe(200);
    });

    it('does not revoke sessions — no tokenGeneration bump', async () => {
      const a = await createApp('dis-sessions');
      const before = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });

      await disable(a.id);
      await enable(a.id);

      const after = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      // Reversibility is the entire feature. Bumping the generation would make
      // the freeze partly one-way: the thaw could not give those sessions back.
      expect(after.tokenGeneration).toBe(before.tokenGeneration);
    });

    it('is idempotent and preserves the ORIGINAL timestamp and reason', async () => {
      const a = await createApp('dis-idem');
      await disable(a.id, 'first reason');
      const first = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });

      expect((await disable(a.id, 'second reason')).statusCode).toBe(200);

      const second = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      expect(second.disabledAt?.getTime()).toBe(first.disabledAt?.getTime());
      expect(second.disabledReason).toBe('first reason');
    });

    it('is never refused on quota, even at the ceiling', async () => {
      await setLimits({ maxProductionApps: 1 });
      const a = await createApp('dis-at-ceiling', { environment: 'PRODUCTION' });
      // Disabling frees a slot, so it can never be the thing that runs out.
      expect((await disable(a.id)).statusCode).toBe(200);
    });

    it('dispatches no outbound webhook while disabled', async () => {
      const a = await createApp('dis-webhook');
      await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${a.id}/webhooks`,
        headers: auth(),
        payload: { url: 'https://example.com/hook', events: ['user.created'] },
      });
      await disable(a.id);

      const pub = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      // Sign-up is refused at the door anyway; assert the deliveries table
      // directly so this still holds if a future non-request emitter appears.
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${pub.publicKey}` },
        payload: { email: `hook-${n}@example.com`, password: PASSWORD },
      });

      const deliveries = await prisma.webhookDelivery.count({ where: { applicationId: a.id } });
      expect(deliveries).toBe(0);
    });
  });

  // ----------------------------------------------------------------- enable

  describe('enable', () => {
    it('restores traffic', async () => {
      const a = await createApp('en-restore');
      const rawKey = (await mintKey(a.id).then((r) => r.json().data as { rawKey: string })).rawKey;

      await disable(a.id);
      expect((await enable(a.id)).statusCode).toBe(200);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(res.statusCode).toBe(200);

      const row = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.disabledAt).toBeNull();
      expect(row.disabledReason).toBeNull();
    });

    it('is idempotent on an application that is not disabled', async () => {
      const a = await createApp('en-idem');
      expect((await enable(a.id)).statusCode).toBe(200);
    });

    it('always enables DEVELOPMENT and STAGING, ceiling or not', async () => {
      await setLimits({ maxProductionApps: 1 });
      await createApp('en-nonprod-holder', { environment: 'PRODUCTION' });

      const dev = await createApp('en-nonprod-dev');
      await disable(dev.id);
      // Non-production applications hold no slot, so the ceiling is irrelevant
      // to them in both directions.
      expect((await enable(dev.id)).statusCode).toBe(200);
    });

    // The bypass this closes: without it, disable/enable would launder an
    // unlimited number of running production applications past the ceiling.
    it('REFUSES to re-enable a production app when the workspace is at its ceiling', async () => {
      await setLimits({ maxProductionApps: 1 });
      const first = await createApp('en-quota-first', { environment: 'PRODUCTION' });

      // Free the slot, spend it on another app, then try to take it back.
      await disable(first.id);
      const second = await createApp('en-quota-second');
      expect((await promote(second.id)).statusCode).toBe(200);

      const res = await enable(first.id);
      expect(res.statusCode).toBe(403);
      expect((res.json().error as { code: string }).code).toBe('TENANT_QUOTA_EXCEEDED');

      const row = await prisma.application.findUniqueOrThrow({ where: { id: first.id } });
      expect(row.disabledAt).not.toBeNull();
    });

    it('the refusal on THIS door never suggests creating a staging app', async () => {
      await setLimits({ maxProductionApps: 1 });
      const first = await createApp('en-fix-text-first', { environment: 'PRODUCTION' });
      await disable(first.id);
      const second = await createApp('en-fix-text-second');
      await promote(second.id);

      const err = (await enable(first.id)).json().error as { fix: string };
      // "Create it in staging instead" is a remedy for the create path. On the
      // re-enable path the operator is bringing a real product back online and
      // it is not a remedy at all, it is a dead end dressed as help.
      expect(err.fix).not.toContain('staging');
      expect(err.fix).toContain('contact support');
    });

    it('swapping which production app runs is allowed at a ceiling of one', async () => {
      await setLimits({ maxProductionApps: 1 });
      const a = await createApp('swap-a', { environment: 'PRODUCTION' });
      const b = await createApp('swap-b');

      await disable(a.id);
      expect((await promote(b.id)).statusCode).toBe(200);
      await disable(b.id);
      expect((await enable(a.id)).statusCode).toBe(200);

      // Two PRODUCTION rows, one running. This is the intended shape, not a
      // leak: the ceiling counts running applications, and only one serves
      // traffic at any moment.
      const prodRows = await prisma.application.count({
        where: { tenantId, environment: 'PRODUCTION' },
      });
      const running = await prisma.application.count({
        where: { tenantId, environment: 'PRODUCTION', disabledAt: null },
      });
      expect(prodRows).toBe(2);
      expect(running).toBe(1);
    });
  });

  // ------------------------------------------------------------- authority

  describe('only the workspace OWNER may run the lifecycle routes', () => {
    it('refuses a workspace ADMIN on promote, disable and enable', async () => {
      const a = await createApp('owner-only');
      const adminToken = await adminOfSameWorkspace();
      const asAdmin = { authorization: `Bearer ${adminToken}` };

      // Sanity first: this ADMIN is genuinely an admin of THIS workspace and
      // can do ordinary application writes. Without this the three 403s below
      // would also pass for a token that simply does not work.
      const ordinaryWrite = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${a.id}/auth-config`,
        headers: asAdmin,
        payload: { passwordMinLength: 10 },
      });
      expect(ordinaryWrite.statusCode).toBe(200);

      for (const [method, url] of [
        ['POST', `/api/v1/tenant/applications/${a.id}/promote`],
        ['POST', `/api/v1/tenant/applications/${a.id}/disable`],
        ['DELETE', `/api/v1/tenant/applications/${a.id}/disable`],
      ] as const) {
        const res = await app.inject({ method, url, headers: asAdmin, payload: {} });
        expect(res.statusCode).toBe(403);
        expect((res.json().error as { code: string }).code).toBe('TENANT_ROLE_INSUFFICIENT');
      }

      // Refused means nothing happened, not "happened and then complained".
      const row = await prisma.application.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.environment).toBe('DEVELOPMENT');
      expect(row.disabledAt).toBeNull();
    });

    it('promoting an application disabled mid-flight reports DISABLED, not ALREADY_PROMOTED', async () => {
      // The 409 pre-check reads the row before the workspace lock is taken, so
      // the conditional update carries `disabledAt: null` too. When that
      // predicate is what missed, the error has to name it — telling an
      // operator their application was "already promoted" sends them looking
      // for a promotion that never happened. Simulated by disabling first,
      // which exercises the same raise site the race reaches.
      const a = await createApp('promote-disabled-code');
      await disable(a.id);

      const res = await promote(a.id);
      expect(res.statusCode).toBe(409);
      expect((res.json().error as { code: string }).code).toBe('APPLICATION_DISABLED');
      expect((res.json().error as { fix: string }).fix).toContain('Enable the application first');
    });

    it('allows the OWNER through the same three routes', async () => {
      const a = await createApp('owner-allowed');
      expect((await disable(a.id)).statusCode).toBe(200);
      expect((await enable(a.id)).statusCode).toBe(200);
      expect((await promote(a.id)).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------- create racing

  // The third door. `create` asserted the quota but took no lock until this
  // test existed, so two concurrent PRODUCTION creates could both pass the
  // count — and with no demote and no delete, the workspace stayed over its
  // ceiling permanently. Verified sensitive: removing `lockWorkspaceSlots`
  // from the create path makes this fail with every racer winning.
  it('concurrent PRODUCTION creates cannot exceed the ceiling', async () => {
    await setLimits({ maxProductionApps: 1 });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/tenant/applications/',
          headers: auth(),
          payload: { name: `crace-${i}`, slug: `crace-${i}-${n}`, environment: 'PRODUCTION' },
        }),
      ),
    );

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(7);
    expect(
      await prisma.application.count({
        where: { tenantId, environment: 'PRODUCTION', disabledAt: null },
      }),
    ).toBe(1);
  });

  // There is deliberately NO test here for "a create racing a promote".
  //
  // It was written, and it could not be made to fail with the create-path lock
  // removed — at every width and ordering tried, `promote` committed before any
  // create had counted (measured: 6 creates all 403, promote 200). A test that
  // cannot fail is not evidence, and one shaped like a race test is worse than
  // none because it reads as proof to the next person.
  //
  // What holds the cross-door case is structural, not empirical: all three
  // doors take the SAME lock on the SAME key, so they are mutually exclusive by
  // construction. The two race tests above are what prove each door actually
  // takes it. If a fourth door is ever added, it needs its own sensitive
  // single-door race test, not a cross-door one.

  // ------------------------------------------------- response serialisation

  // These assertions are not redundant with the ones above, and the difference
  // matters. Every other test in this file reads the row back through Prisma,
  // which proves the WRITE happened. Fastify serialises responses against the
  // route's JSON schema and DROPS any property the schema does not declare, so
  // a field can be written perfectly and still never reach the panel. The
  // panel's disabled banner and promote gating are driven entirely by these
  // three fields, so they have to be asserted on the wire.
  describe('the API actually returns the lifecycle fields', () => {
    it('exposes promotedAt on the promote response and on a later GET', async () => {
      const a = await createApp('wire-promote');
      const promoted = (await promote(a.id)).json().data as Record<string, unknown>;
      expect(promoted.promotedAt).toEqual(expect.any(String));

      const fetched = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/tenant/applications/${a.id}`,
          headers: auth(),
        })
      ).json().data as Record<string, unknown>;
      expect(fetched.promotedAt).toEqual(expect.any(String));
    });

    it('exposes disabledAt and disabledReason, and clears them on enable', async () => {
      const a = await createApp('wire-disable');
      const disabled = (await disable(a.id, 'wire test')).json().data as Record<string, unknown>;
      expect(disabled.disabledAt).toEqual(expect.any(String));
      expect(disabled.disabledReason).toBe('wire test');

      const fetched = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/tenant/applications/${a.id}`,
          headers: auth(),
        })
      ).json().data as Record<string, unknown>;
      expect(fetched.disabledAt).toEqual(expect.any(String));

      const enabled = (await enable(a.id)).json().data as Record<string, unknown>;
      expect(enabled.disabledAt).toBeNull();
    });

    it('shows disabledAt in the application LIST, which is where the panel reads it', async () => {
      const a = await createApp('wire-list');
      await disable(a.id);

      // The list is paged — `data` is { items, total, limit, offset }, not an
      // array. Asserted here rather than assumed: the panel sidebar and the
      // command palette are both fed by this endpoint, so the field has to
      // survive the page wrapper as well as the row serialiser.
      const page = (
        await app.inject({
          method: 'GET',
          url: '/api/v1/tenant/applications',
          headers: auth(),
        })
      ).json().data as { items: Array<Record<string, unknown>> };
      const row = page.items.find((r) => r.id === a.id);
      expect(row).toBeDefined();
      expect(row?.disabledAt).toEqual(expect.any(String));
    });
  });

  // ----------------------------------------------------------------- limits

  describe('GET /tenant/workspace/limits', () => {
    it('reports unlimited as an ABSENT key, never as zero', async () => {
      const res = await readLimits();
      expect(res.statusCode).toBe(200);
      const body = res.json().data as { limits: Record<string, unknown> };
      // A client reading a missing key as 0 would disable the promote button
      // on every unlimited workspace, which is every self-host by default.
      expect(body.limits.maxProductionApps).toBeUndefined();
    });

    it('counts RUNNING production apps, so disabling one frees the reported slot', async () => {
      await setLimits({ maxProductionApps: 2 });
      const a = await createApp('lim-a', { environment: 'PRODUCTION' });

      const before = (await readLimits()).json().data as { usage: { productionApps: number } };
      expect(before.usage.productionApps).toBe(1);

      await disable(a.id);

      const after = (await readLimits()).json().data as {
        usage: { productionApps: number };
        limits: { maxProductionApps: number };
      };
      expect(after.usage.productionApps).toBe(0);
      expect(after.limits.maxProductionApps).toBe(2);
    });

    it('refuses a MEMBER — the usage figures are workspace-wide', async () => {
      // The application list is grant-scoped precisely so a MEMBER with three
      // applications is not told the workspace has forty. This endpoint reports
      // that same count workspace-wide, plus a workspace-wide end-user
      // headcount, so leaving it open would reintroduce the oracle the list
      // scoping exists to prevent.
      const email = `lifecycle-member-${n}@example.com`;
      const signUp = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email, password: PASSWORD, workspaceName: `Member ${n}` },
      });
      const user = await prisma.tenantUser.findUniqueOrThrow({ where: { email } });
      await prisma.tenantMembership.create({
        data: { tenantUserId: user.id, tenantId, role: 'MEMBER' },
      });
      const switched = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/switch-workspace',
        headers: {
          authorization: `Bearer ${(signUp.json().data as { accessToken: string }).accessToken}`,
        },
        payload: { tenantId },
      });
      expect(switched.statusCode).toBe(200);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/workspace/limits',
        headers: {
          authorization: `Bearer ${(switched.json().data as { accessToken: string }).accessToken}`,
        },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json().error as { code: string }).code).toBe('TENANT_ROLE_INSUFFICIENT');
    });

    it('agrees with what the server actually enforces', async () => {
      await setLimits({ maxProductionApps: 1 });
      await createApp('lim-agree', { environment: 'PRODUCTION' });

      const view = (await readLimits()).json().data as {
        limits: { maxProductionApps: number };
        usage: { productionApps: number };
      };
      // The client gate and the server gate must reach the same verdict; a
      // disagreement is a button that lies in one direction or the other.
      expect(view.usage.productionApps).toBe(view.limits.maxProductionApps);

      const candidate = await createApp('lim-agree-candidate');
      expect((await promote(candidate.id)).statusCode).toBe(403);
    });
  });
});
