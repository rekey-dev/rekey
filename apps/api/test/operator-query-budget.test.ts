/**
 * Query budget for the operator hot paths, measured, not estimated.
 *
 * Every number below is the count of SQL statements Prisma sent (see
 * `query-counter.ts` for what is excluded). The panel's application overview
 * page issues the seven GETs in OVERVIEW_PATHS in parallel on every
 * navigation, so its budget is the sum.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { flushApiRequestLogs } from '../src/lib/request-log.js';
import { countQueries } from './query-counter.js';
import { __resetForTests } from '../src/lib/operator-auth-cache.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('operator query budget', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.77.0.1';

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: ip, ...opts } as never);
  }
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  async function bootstrap(): Promise<{ owner: string; member: string; appId: string }> {
    ip = `10.77.${++n}.1`;
    const tag = `qb-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const signUp = async (email: string, ws: string) => {
      const r = await inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email, password: 'pw-one-two-three', workspaceName: ws },
      });
      expect(r.statusCode).toBe(201);
      return (r.json().data as { accessToken: string }).accessToken;
    };
    const owner = await signUp(`owner-${tag}@example.com`, 'Budget Co');
    const invitee = await signUp(`member-${tag}@example.com`, 'Member Co');
    const created = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: auth(owner),
      payload: { name: `App ${tag}`, slug: tag },
    });
    expect(created.statusCode).toBe(201);
    const appId = (created.json().data as { id: string }).id;
    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: auth(owner),
      payload: { email: `member-${tag}@example.com`, role: 'MEMBER' },
    });
    const accept = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(invitee),
      payload: { token: (inv.json().data as { token: string }).token },
    });
    expect(accept.statusCode).toBe(200);
    const member = (accept.json().data as { accessToken: string }).accessToken;
    const members = await inject({ method: 'GET', url: '/api/v1/tenant/workspace/members', headers: auth(owner) });
    const membershipId = (
      members.json().data as { items: Array<{ membershipId: string; email: string }> }
    ).items.find((m) => m.email === `member-${tag}@example.com`)!.membershipId;
    const g = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: auth(owner),
      payload: { applicationId: appId, role: 'APP_ADMIN' },
    });
    expect(g.statusCode).toBe(200);
    await flushApiRequestLogs();
    return { owner, member, appId };
  }

  const overviewPaths = (id: string) => [
    '/api/v1/tenant/auth/me',
    '/api/v1/tenant/workspace/creation-mode',
    `/api/v1/tenant/applications/${id}`,
    `/api/v1/tenant/applications/${id}/api-keys`,
    `/api/v1/tenant/applications/${id}/billing-credentials`,
    `/api/v1/tenant/applications/${id}/plans`,
    `/api/v1/tenant/applications/${id}/stats`,
  ];

  async function get(token: string, url: string): Promise<void> {
    const r = await inject({ method: 'GET', url, headers: auth(token) });
    expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
  }

  /**
   * Measured on origin/main before this change (same seed, same counter):
   *
   *   one operator request, auth only           3
   *   GET /applications/:id, OWNER              5
   *   GET /applications/:id, MEMBER w/ grant    7
   *   application overview, 7 GETs in sequence  48
   *   super-admin application list, 31 apps     96  (3 + 3 per row; 1,503 at the 500-row scan cap)
   *   super-admin overview                      28
   *
   * The budgets below are ceilings, so an unrelated handler change that
   * adds a read fails here and is looked at, rather than slipping through.
   */
  it('stays inside the budget', async () => {
    const { owner, member, appId } = await bootstrap();
    const out: Record<string, number> = {};
    const measure = async (label: string, fn: () => Promise<unknown>): Promise<number> => {
      const c = await countQueries(fn);
      out[label] = c.count;
      return c.count;
    };
    const creationMode = '/api/v1/tenant/workspace/creation-mode';

    __resetForTests();
    expect(await measure('operator request, cold', () => get(owner, creationMode))).toBe(3);
    expect(await measure('operator request, warm', () => get(owner, creationMode))).toBe(0);

    __resetForTests();
    await measure('GET app OWNER, cold', () => get(owner, `/api/v1/tenant/applications/${appId}`));
    expect(await measure('GET app OWNER, warm', () => get(owner, `/api/v1/tenant/applications/${appId}`))).toBe(1);
    await measure('GET app MEMBER, cold', () => get(member, `/api/v1/tenant/applications/${appId}`));
    expect(await measure('GET app MEMBER, warm', () => get(member, `/api/v1/tenant/applications/${appId}`))).toBe(1);

    __resetForTests();
    const cold = await measure('overview sequential, cold', async () => {
      for (const p of overviewPaths(appId)) await get(owner, p);
    });
    expect(cold).toBeLessThanOrEqual(13);
    const warm = await measure('overview sequential, warm', async () => {
      for (const p of overviewPaths(appId)) await get(owner, p);
    });
    expect(warm).toBeLessThanOrEqual(9);

    // Super-admin: the per-row fan-out is gone, so the count must not move
    // with the number of rows listed.
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    const seed = async (count: number) => {
      for (let i = 0; i < count; i++) {
        await prisma.application.create({
          data: {
            tenantId: tenants[i % tenants.length]!.id,
            name: `Seed ${i}`,
            slug: `seed-${i}-${Math.random().toString(36).slice(2, 9)}`,
            publicKey: `pk_seed_${i}_${Math.random().toString(36).slice(2, 12)}`,
            authConfig: {},
            billingConfig: {},
          },
        });
      }
    };
    const admin = (url: string) =>
      inject({ method: 'GET', url, headers: auth(ADMIN_KEY) }).then((r) => {
        expect(r.statusCode, r.body).toBe(200);
      });
    await seed(30);
    const apps31 = await measure('admin applications, 31 rows', () =>
      admin('/api/v1/admin/metrics/applications?sort=endUserCount'),
    );
    await seed(30);
    const apps61 = await measure('admin applications, 61 rows', () =>
      admin('/api/v1/admin/metrics/applications?sort=endUserCount'),
    );
    expect(apps61).toBe(apps31);
    expect(apps31).toBeLessThanOrEqual(6);
    expect(
      await measure('admin tenants', () => admin('/api/v1/admin/metrics/tenants?sort=mrrCents')),
    ).toBeLessThanOrEqual(7);
    // Uncached here (no Redis under test); in production a hit costs 0.
    expect(await measure('admin overview', () => admin('/api/v1/admin/metrics/overview'))).toBeLessThanOrEqual(5);

    console.log('QUERY_BUDGET ' + JSON.stringify(out));
  });
});
