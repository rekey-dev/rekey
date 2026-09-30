/**
 * `GET /api/v1/tenant/applications` filters, sorts and `include=summary`.
 *
 * The panel's Applications list is built on these: disabled applications
 * hidden by default, search over name and slug, environment, three sorts, and
 * a per-row key count and last-active day with no request per row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { countQueries } from './query-counter.js';

interface Row {
  id: string;
  name: string;
  slug: string;
  environment: string;
  disabledAt: string | null;
  summary?: { activeApiKeys?: number; lastActiveOn?: string | null };
}
interface ListBody {
  items: Row[];
  page: { total: number; hasMore: boolean };
}

describe('tenant application list filters', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.71.0.1';

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const inject = (opts: Record<string, unknown>) => app.inject({ remoteAddress: ip, ...opts } as never);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function signUp(email: string, workspaceName: string): Promise<string> {
    const r = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { accessToken: string }).accessToken;
  }

  async function list(token: string, query: string): Promise<ListBody> {
    const r = await inject({ method: 'GET', url: `/api/v1/tenant/applications/?${query}`, headers: auth(token) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().data as ListBody;
  }

  const names = (b: ListBody): string[] => b.items.map((i) => i.name);

  /**
   * Five applications with distinct shapes:
   *   Alpha Web     PRODUCTION   2 live keys, 1 revoked, 1 expired, users active 1 day ago
   *   beta_mobile   DEVELOPMENT  no keys, a user active 5 days ago
   *   Gamma 100%    DEVELOPMENT  1 key used 3 days ago, no users
   *   Delta Legacy  PRODUCTION   disabled, 1 key
   *   Epsilon       STAGING      nothing at all
   */
  async function seed(): Promise<{ owner: string; ids: Record<string, string>; tag: string }> {
    ip = `10.71.${++n}.1`;
    const tag = `alf${n}${Math.random().toString(36).slice(2, 6)}`;
    const owner = await signUp(`owner-${tag}@example.com`, 'List Co');
    const ids: Record<string, string> = {};
    const specs: Array<[string, string, string, number]> = [
      ['Delta Legacy', `${tag}-delta`, 'PRODUCTION', 50],
      ['Gamma 100%', `${tag}-gamma`, 'DEVELOPMENT', 40],
      ['beta_mobile', `${tag}-mobile-b`, 'DEVELOPMENT', 30],
      ['Alpha Web', `${tag}-alpha`, 'PRODUCTION', 20],
      ['Epsilon', `${tag}-eps`, 'STAGING', 10],
    ];
    for (const [name, slug, environment, ageDays] of specs) {
      const r = await inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(owner),
        payload: { name, slug, environment },
      });
      expect(r.statusCode, r.body).toBe(201);
      const id = (r.json().data as { id: string }).id;
      ids[name] = id;
      await prisma.application.update({ where: { id }, data: { createdAt: new Date(Date.now() - ageDays * 86_400_000) } });
    }
    const day = (ago: number): Date => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return new Date(d.getTime() - ago * 86_400_000);
    };
    const key = (applicationId: string, extra: Record<string, unknown> = {}) =>
      prisma.apiKey.create({
        data: { applicationId, name: 'k', keyPrefix: 'rp_test_', keyHash: `h-${Math.random()}`, scopes: ['*'], ...extra },
      });
    await key(ids['Alpha Web']!);
    await key(ids['Alpha Web']!);
    await key(ids['Alpha Web']!, { revokedAt: new Date() });
    await key(ids['Alpha Web']!, { expiresAt: new Date(Date.now() - 60_000) });
    await key(ids['Gamma 100%']!, { lastUsedAt: new Date(day(3).getTime() + 3_600_000) });
    await key(ids['Delta Legacy']!);
    await prisma.endUser.create({ data: { applicationId: ids['Alpha Web']!, email: `a-${tag}@example.com`, lastActiveOn: day(1) } });
    await prisma.endUser.create({ data: { applicationId: ids['beta_mobile']!, email: `b-${tag}@example.com`, lastActiveOn: day(5) } });
    const off = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${ids['Delta Legacy']}/disable`,
      headers: auth(owner),
      payload: { reason: 'retired' },
    });
    expect(off.statusCode, off.body).toBe(200);
    return { owner, ids, tag };
  }

  it('keeps the unfiltered list whole and newest first', async () => {
    const { owner } = await seed();
    const all = await list(owner, '');
    expect(names(all)).toEqual(['Epsilon', 'Alpha Web', 'beta_mobile', 'Gamma 100%', 'Delta Legacy']);
    expect(all.page.total).toBe(5);
    expect(all.items[0]!.summary).toBeUndefined();
  });

  it('filters by status, and the total counts the filtered set', async () => {
    const { owner } = await seed();
    const active = await list(owner, 'status=active');
    expect(names(active)).not.toContain('Delta Legacy');
    expect(active.page.total).toBe(4);
    const disabled = await list(owner, 'status=disabled&limit=1');
    expect(names(disabled)).toEqual(['Delta Legacy']);
    expect(disabled.page.total).toBe(1);
  });

  it('filters by environment and combines with status', async () => {
    const { owner } = await seed();
    expect(names(await list(owner, 'environment=PRODUCTION'))).toEqual(['Alpha Web', 'Delta Legacy']);
    expect(names(await list(owner, 'environment=PRODUCTION&status=active'))).toEqual(['Alpha Web']);
    expect(names(await list(owner, 'environment=STAGING'))).toEqual(['Epsilon']);
  });

  it('searches name and slug case-insensitively, with LIKE wildcards taken literally', async () => {
    const { owner, tag } = await seed();
    expect(names(await list(owner, 'q=ALPHA'))).toEqual(['Alpha Web']);
    // "mobile-b" only appears in beta's slug.
    expect(names(await list(owner, `q=${tag}-MOBILE`))).toEqual(['beta_mobile']);
    expect(names(await list(owner, `q=${encodeURIComponent('100%')}`))).toEqual(['Gamma 100%']);
    // `%` and `_` would match everything if passed through as patterns.
    expect((await list(owner, `q=${encodeURIComponent('%')}`)).page.total).toBe(1);
    expect(names(await list(owner, 'q=_'))).toEqual(['beta_mobile']);
    expect((await list(owner, 'q=nothing-like-this')).page.total).toBe(0);
  });

  it('sorts by name and by last activity, never-active last', async () => {
    const { owner } = await seed();
    expect(names(await list(owner, 'sort=name'))).toEqual(['Alpha Web', 'beta_mobile', 'Delta Legacy', 'Epsilon', 'Gamma 100%']);
    const byActivity = names(await list(owner, 'sort=activity'));
    expect(byActivity.slice(0, 3)).toEqual(['Alpha Web', 'Gamma 100%', 'beta_mobile']);
    // The two with no activity fall back to newest first.
    expect(byActivity.slice(3)).toEqual(['Epsilon', 'Delta Legacy']);
    // The sorted path builds its own WHERE; filters must hold there too.
    expect(names(await list(owner, 'sort=name&status=disabled'))).toEqual(['Delta Legacy']);
    expect(names(await list(owner, `sort=activity&q=${encodeURIComponent('%')}`))).toEqual(['Gamma 100%']);
    expect(names(await list(owner, 'sort=activity&environment=PRODUCTION&status=active'))).toEqual(['Alpha Web']);
    const paged = await list(owner, 'sort=activity&limit=2&offset=2');
    expect(names(paged)).toEqual(['beta_mobile', 'Epsilon']);
    expect(paged.page.hasMore).toBe(true);
  });

  it('rejects an unknown sort or status rather than ignoring it', async () => {
    const { owner } = await seed();
    for (const q of ['sort=users', 'status=deleted', 'environment=prod', 'include=everything']) {
      const r = await inject({ method: 'GET', url: `/api/v1/tenant/applications/?${q}`, headers: auth(owner) });
      expect(r.statusCode, q).toBe(400);
    }
  });

  it('summarises active keys and the last active day', async () => {
    const { owner } = await seed();
    const rows = new Map((await list(owner, 'include=summary')).items.map((r) => [r.name, r.summary]));
    // Revoked and expired keys do not count.
    expect(rows.get('Alpha Web')!.activeApiKeys).toBe(2);
    expect(rows.get('beta_mobile')!.activeApiKeys).toBe(0);
    expect(rows.get('Gamma 100%')!.activeApiKeys).toBe(1);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const ago = (iso: string | null | undefined): number | null =>
      iso ? Math.round((today.getTime() - new Date(iso).getTime()) / 86_400_000) : null;
    expect(ago(rows.get('Alpha Web')!.lastActiveOn)).toBe(1);
    expect(ago(rows.get('beta_mobile')!.lastActiveOn)).toBe(5);
    // A key's use counts as activity when no end-user has any.
    expect(ago(rows.get('Gamma 100%')!.lastActiveOn)).toBe(3);
    expect(rows.get('Epsilon')!.lastActiveOn).toBeNull();
  });

  it('costs the same number of queries for one row as for five', async () => {
    const { owner } = await seed();
    const one = await countQueries(() => list(owner, 'include=summary&limit=1'));
    const five = await countQueries(() => list(owner, 'include=summary&limit=5'));
    expect(five.count).toBe(one.count);
  });

  /** A MEMBER of the seeded workspace, APP_VIEWER on `grantNames`, holding `scopes` when given. */
  async function addMember(
    seeded: { owner: string; ids: Record<string, string>; tag: string },
    grantNames: string[],
    scopes?: string[],
  ): Promise<{ token: string; setScopes: (next: string[]) => Promise<void> }> {
    const { owner, ids, tag } = seeded;
    const email = `member-${tag}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    const invitee = await signUp(email, 'Member Own Co');
    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: auth(owner),
      payload: { email, role: 'MEMBER' },
    });
    const accept = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(invitee),
      payload: { token: (inv.json().data as { token: string }).token },
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const token = (accept.json().data as { accessToken: string }).accessToken;
    const members = await inject({ method: 'GET', url: '/api/v1/tenant/workspace/members', headers: auth(owner) });
    const membershipId = (members.json().data as { items: Array<{ membershipId: string; email: string }> }).items.find(
      (m) => m.email === email,
    )!.membershipId;
    for (const name of grantNames) {
      const g = await inject({
        method: 'PUT',
        url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
        headers: auth(owner),
        payload: { applicationId: ids[name], role: 'APP_VIEWER' },
      });
      expect(g.statusCode, g.body).toBe(200);
    }
    const setScopes = async (next: string[]): Promise<void> => {
      const r = await inject({
        method: 'PATCH',
        url: `/api/v1/tenant/workspace/members/${membershipId}`,
        headers: auth(owner),
        payload: { scopes: next },
      });
      expect(r.statusCode, r.body).toBe(200);
    };
    if (scopes) await setScopes(scopes);
    return { token, setScopes };
  }

  it('scopes a MEMBER to granted applications and hides what their scopes cannot read', async () => {
    const seeded = await seed();
    const { token: member, setScopes } = await addMember(seeded, ['Alpha Web', 'beta_mobile']);

    const granted = await list(member, 'include=summary&status=active');
    expect(names(granted).sort()).toEqual(['Alpha Web', 'beta_mobile']);
    expect(granted.page.total).toBe(2);
    expect((await list(member, 'status=disabled')).page.total).toBe(0);
    expect((await list(member, 'q=gamma')).page.total).toBe(0);

    // Make activity order the reverse of creation order, so the two sorts
    // below can be told apart.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await prisma.endUser.updateMany({ where: { applicationId: seeded.ids['beta_mobile']! }, data: { lastActiveOn: today } });
    expect(names(await list(member, 'sort=activity'))).toEqual(['beta_mobile', 'Alpha Web']);

    await setScopes(['end-users:read']);
    const narrowed = await list(member, 'include=summary&sort=activity');
    for (const row of narrowed.items) {
      expect(row.summary).toBeDefined();
      expect(row.summary).not.toHaveProperty('activeApiKeys');
      expect(row.summary).not.toHaveProperty('lastActiveOn');
    }
    // Without overview:read the activity order is not applied, so it cannot
    // be read off the row order either: newest first instead.
    expect(names(narrowed)).toEqual(['Alpha Web', 'beta_mobile']);
  });

  it('shows each summary field only with the scope that owns it', async () => {
    const seeded = await seed();
    const cases: Array<[string[], string[]]> = [
      [['overview:read'], ['lastActiveOn']],
      [['developer:read'], ['activeApiKeys']],
      [['overview:read', 'developer:read'], ['activeApiKeys', 'lastActiveOn']],
    ];
    for (const [scopes, fields] of cases) {
      const { token } = await addMember(seeded, ['Alpha Web'], scopes);
      const [row] = (await list(token, 'include=summary')).items;
      expect(Object.keys(row!.summary ?? {}).sort(), scopes.join(',')).toEqual(fields);
    }
  });

  it("counts a key's last use as activity only for a caller who may read keys", async () => {
    const seeded = await seed();
    // Gamma's only activity is a key used 3 days ago. Epsilon is newer and has none.
    const { token, setScopes } = await addMember(seeded, ['Gamma 100%', 'Epsilon'], ['overview:read']);
    const hidden = await list(token, 'include=summary&sort=activity');
    expect(hidden.items.find((r) => r.name === 'Gamma 100%')!.summary!.lastActiveOn).toBeNull();
    // With the key term hidden neither row has activity, so the order is newest first.
    expect(names(hidden)).toEqual(['Epsilon', 'Gamma 100%']);

    await setScopes(['overview:read', 'developer:read']);
    const shown = await list(token, 'include=summary&sort=activity');
    expect(shown.items.find((r) => r.name === 'Gamma 100%')!.summary!.lastActiveOn).not.toBeNull();
    expect(names(shown)).toEqual(['Gamma 100%', 'Epsilon']);
  });
});
