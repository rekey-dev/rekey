/**
 * GET /api/v1/lists/:key/members: the elevated read a server syncs from.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { setDeliveryScheduler } from '../src/modules/webhooks/webhook.service.js';
import { contactsHarness, type ContactsWorld } from './contacts-fixtures.js';

describe('list members API', () => {
  let app: FastifyInstance;
  const h = contactsHarness(() => app, '84');
  const { inject, auth, world, createList, mintKey, memberWith } = h;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => setDeliveryScheduler(() => undefined));
  afterEach(() => setDeliveryScheduler(null));

  interface Filled extends ContactsWorld {
    writer: string;
    reader: string;
  }

  async function filled(count: number): Promise<Filled> {
    const w = await world();
    await createList(w, { lawfulBasis: 'contract' });
    const writer = await mintKey(w);
    for (let i = 0; i < count; i++) {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/lists/newsletter/subscribe',
        headers: auth(writer),
        payload: { email: `m${i}@example.com` },
      });
      expect(res.statusCode).toBe(200);
    }
    return { ...w, writer, reader: await mintKey(w, ['contacts:read']) };
  }

  const members = (token: string, query = '') =>
    inject({ method: 'GET', url: `/api/v1/lists/newsletter/members${query}`, headers: auth(token) });

  it('is elevated: a * key is refused, a contacts:read key reads', async () => {
    const w = await filled(1);
    const refused = await members(w.writer);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
    const ok = await members(w.reader);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.items[0]).toMatchObject({ email: 'm0@example.com', status: 'subscribed', source: 'secret' });
    expect((await members(w.publicKey)).statusCode).toBe(401);
  });

  it('pages oldest change first with a cursor, without repeats', async () => {
    const w = await filled(7);
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const res = await members(w.reader, `?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      const page = res.json().data as { items: Array<{ email: string }>; nextCursor: string | null };
      sizes.push(page.items.length);
      seen.push(...page.items.map((m) => m.email));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([3, 3, 1]);
    expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `m${i}@example.com`));
  });

  it('pages correctly when every member changed in the same millisecond', async () => {
    const w = await filled(5);
    await prisma.contactListMember.updateMany({ data: { updatedAt: new Date('2026-09-29T00:00:00.000Z') } });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await members(w.reader, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      const page = res.json().data as { items: Array<{ email: string }>; nextCursor: string | null };
      seen.push(...page.items.map((m) => m.email));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(Array.from({ length: 5 }, (_, i) => `m${i}@example.com`));
  });

  it('syncs changes with updatedSince, including unsubscribes when asked for status=all', async () => {
    const w = await filled(3);
    const first = (await members(w.reader)).json().data.items as Array<{ updatedAt: string }>;
    const mark = first.at(-1)!.updatedAt;
    await inject({ method: 'DELETE', url: '/api/v1/lists/newsletter/members/m1@example.com', headers: auth(w.writer) });

    const subscribedOnly = await members(w.reader, `?updatedSince=${encodeURIComponent(mark)}`);
    expect(subscribedOnly.json().data.items).toEqual([]);
    const all = await members(w.reader, `?status=all&updatedSince=${encodeURIComponent(mark)}`);
    expect(all.json().data.items.map((m: { email: string; status: string }) => [m.email, m.status])).toEqual([
      ['m1@example.com', 'unsubscribed'],
    ]);
    const current = await members(w.reader);
    expect(current.json().data.items.map((m: { email: string }) => m.email)).toEqual(['m0@example.com', 'm2@example.com']);
  });

  it('GET /lists gives a * key the lists and their counts, never addresses', async () => {
    const w = await filled(2);
    await createList(w, { key: 'waitlist', name: 'Waitlist' });
    const res = await inject({ method: 'GET', url: '/api/v1/lists', headers: auth(w.writer) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.items).toEqual([
      { key: 'newsletter', name: 'Newsletter', kind: 'generic', publicCapture: false, archived: false, subscribed: 2, unsubscribed: 0 },
      { key: 'waitlist', name: 'Waitlist', kind: 'generic', publicCapture: false, archived: false, subscribed: 0, unsubscribed: 0 },
    ]);
    expect((await inject({ method: 'GET', url: '/api/v1/lists', headers: auth(w.publicKey) })).statusCode).toBe(401);
  });

  it('refuses a cursor it did not issue', async () => {
    const w = await filled(1);
    const res = await members(w.reader, '?cursor=bm9wZQ');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CONTACT_CURSOR_INVALID');
  });

  describe('minting contacts:read', () => {
    it('needs the audience:read scope: a member restricted to developer:write is refused', async () => {
      const w = await world();
      const member = await memberWith(w, 'APP_ADMIN');
      const list = await inject({ method: 'GET', url: '/api/v1/tenant/workspace/members', headers: auth(w.ownerToken) });
      const membershipId = (list.json().data.items as Array<{ membershipId: string; role: string }>).find(
        (m) => m.role === 'MEMBER',
      )!.membershipId;
      const scoped = await inject({
        method: 'PATCH',
        url: `/api/v1/tenant/workspace/members/${membershipId}`,
        headers: auth(w.ownerToken),
        payload: { scopes: ['developer:write'] },
      });
      expect(scoped.statusCode, scoped.body).toBe(200);

      const mint = (token: string, scopes: string[]) =>
        inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${w.appId}/api-keys`,
          headers: auth(token),
          payload: { name: 'k', scopes },
        });
      expect((await mint(member, ['*'])).statusCode).toBe(201);
      const refused = await mint(member, ['contacts:read']);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('SCOPE_INSUFFICIENT');
      expect(refused.json().error.message).toContain('audience:read');
      expect((await mint(w.ownerToken, ['contacts:read'])).statusCode).toBe(201);
      expect(await prisma.apiKey.count({ where: { applicationId: w.appId, scopes: { has: 'contacts:read' } } })).toBe(1);
    });
  });
});
