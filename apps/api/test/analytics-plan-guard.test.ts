/**
 * No dashboard statement may need a sequential scan of a big table. Every
 * query the Users overview sends on a cache miss is EXPLAINed with
 * `enable_seqscan = off`; a Seq Scan that survives means no index serves it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { seedUsers } from './analytics-seed.js';
import { rollupApplication } from '../src/modules/analytics/rollup/job.js';
import { recordStatements, seqScansOnBigTables } from './analytics-explain.js';
import { bearer, operatorWorld } from './operator-world.js';

describe('analytics plan guard', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('flags a query no index can serve (the guard itself works)', async () => {
    const found = await seqScansOnBigTables(['SELECT count(*) FROM "end_users" WHERE "last_country" = $1']);
    expect(found).toHaveLength(1);
    expect(found[0]!.tables).toEqual(['end_users']);
  });

  it.each([
    ['', 'defaults'],
    ['?range=7d&platform=ios&verified=true&mfa=true', 'user filters'],
    ['?range=30d&createdVia=oauth,unknown&onboarding=skipped', 'createdVia and onboarding'],
    ['?range=custom&from=__FROM__&to=__TO__&compare=none', 'custom range'],
    ['?paying=true&org=__ORG__', 'paying and org'],
  ])('every section is index-served: %s (%s)', async (qs) => {
    const w = await operatorWorld(app);
    await seedUsers(w.appId, 60, 3);
    const org = await prisma.organization.create({ data: { applicationId: w.appId, name: 'O', slug: 'o' } });
    const current = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    await prisma.application.update({
      where: { id: w.appId },
      data: { billingConfig: { ...(current.billingConfig as object), enabled: true } },
    });
    await prisma.usageMeter.create({ data: { applicationId: w.appId, slug: 'api', name: 'API', unit: 'call' } });
    const today = new Date().toISOString().slice(0, 10);
    const query = qs.replace('__ORG__', org.id).replace('__FROM__', new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)).replace('__TO__', today);
    const statements = await recordStatements(async () => {
      const res = await w.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${w.appId}/analytics/users${query}`,
        headers: bearer(w.ownerToken),
      });
      expect(res.statusCode, res.body).toBe(200);
    });
    expect(statements.length).toBeGreaterThan(3);
    expect(await seqScansOnBigTables(statements)).toEqual([]);
  });

  it('the rollup read path is index-served too', async () => {
    const w = await operatorWorld(app);
    await seedUsers(w.appId, 60, 4);
    await rollupApplication(w.appId);
    const statements = await recordStatements(async () => {
      const res = await w.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${w.appId}/analytics/users?range=90d&platform=ios`,
        headers: bearer(w.ownerToken),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.sections.activity.source).toBe('rollup');
    });
    expect(await seqScansOnBigTables(statements)).toEqual([]);
  });
});
