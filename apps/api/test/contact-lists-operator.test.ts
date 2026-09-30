/**
 * What the panel reads and does on one list: members, submissions, taking
 * someone off, and the CSV export floor.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { setDeliveryScheduler } from '../src/modules/webhooks/webhook.service.js';
import { contactsHarness, type ContactsWorld } from './contacts-fixtures.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

describe('operator list reads', () => {
  let app: FastifyInstance;
  const h = contactsHarness(() => app, '85');
  const { inject, auth, world, base, createList, mintKey, memberWith, adminOf } = h;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => setDeliveryScheduler(() => undefined));
  afterEach(() => setDeliveryScheduler(null));

  interface Seeded extends ContactsWorld {
    listId: string;
    secret: string;
  }

  async function seeded(): Promise<Seeded> {
    const w = await world();
    const list = await createList(w, {
      lawfulBasis: 'contract',
      fieldSchema: [{ name: 'message', label: 'Message', type: 'textarea' }],
    });
    return { ...w, listId: list.json().data.id as string, secret: await mintKey(w) };
  }

  const subscribe = (w: Seeded, payload: Record<string, unknown>) =>
    inject({ method: 'POST', url: '/api/v1/lists/newsletter/subscribe', headers: auth(w.secret), payload });

  it('lists members with search, status filter, totals and the end-user join', async () => {
    const w = await seeded();
    await inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: auth(w.secret),
      payload: { email: 'ada@example.com', password: 'pw-one-two-three' },
    });
    await subscribe(w, { email: 'ada@example.com', name: 'Ada' });
    await subscribe(w, { email: 'grace@example.com', name: 'Grace Hopper' });
    await subscribe(w, { email: 'left@example.com' });
    await prisma.contactListMember.updateMany({
      where: { contact: { email: 'left@example.com' } },
      data: { status: 'unsubscribed' },
    });

    const all = await inject({ method: 'GET', url: `${base(w)}/lists/${w.listId}/members`, headers: auth(w.ownerToken) });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().data.page.total).toBe(3);
    const ada = all.json().data.items.find((m: { email: string }) => m.email === 'ada@example.com');
    expect(ada.endUserId).toMatch(/.+/);
    expect(all.json().data.items.find((m: { email: string }) => m.email === 'grace@example.com').endUserId).toBeNull();

    const hopper = await inject({
      method: 'GET',
      url: `${base(w)}/lists/${w.listId}/members?search=HOPPER`,
      headers: auth(w.ownerToken),
    });
    expect(hopper.json().data.items.map((m: { email: string }) => m.email)).toEqual(['grace@example.com']);

    const left = await inject({
      method: 'GET',
      url: `${base(w)}/lists/${w.listId}/members?status=unsubscribed&limit=1`,
      headers: auth(w.ownerToken),
    });
    expect(left.json().data.items.map((m: { email: string }) => m.email)).toEqual(['left@example.com']);
    expect(left.json().data.page).toEqual({ total: 1, limit: 1, offset: 0, hasMore: false });
  });

  it('lists submissions newest first', async () => {
    const w = await seeded();
    await subscribe(w, { email: 'a@example.com', fields: { message: 'first' } });
    await subscribe(w, { email: 'b@example.com', fields: { message: 'second' } });
    const res = await inject({ method: 'GET', url: `${base(w)}/lists/${w.listId}/submissions`, headers: auth(w.ownerToken) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.items.map((s: { email: string; fields: { message: string } }) => [s.email, s.fields.message])).toEqual([
      ['b@example.com', 'second'],
      ['a@example.com', 'first'],
    ]);
  });

  it('an operator takes someone off once, with one webhook, and a member of another list is not found', async () => {
    const w = await seeded();
    await prisma.webhookEndpoint.create({
      data: { applicationId: w.appId, url: 'https://127.0.0.1:1/never', secret: 'whsec_op', events: ['contact.unsubscribed'], enabled: true },
    });
    await subscribe(w, { email: 'a@example.com' });
    const member = await prisma.contactListMember.findFirstOrThrow({ where: { listId: w.listId } });
    const url = `${base(w)}/lists/${w.listId}/members/${member.id}/unsubscribe`;
    for (let i = 0; i < 2; i++) {
      const res = await inject({ method: 'POST', url, headers: auth(w.ownerToken) });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.status).toBe('unsubscribed');
    }
    expect(await prisma.webhookDelivery.count({ where: { applicationId: w.appId, eventType: 'contact.unsubscribed' } })).toBe(1);

    const other = await createList(w, { key: 'other', name: 'Other', lawfulBasis: 'contract' });
    const wrong = await inject({
      method: 'POST',
      url: `${base(w)}/lists/${other.json().data.id}/members/${member.id}/unsubscribe`,
      headers: auth(w.ownerToken),
    });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json().error.code).toBe('LIST_MEMBER_NOT_FOUND');
  });

  describe('CSV export', () => {
    it('is an OWNER/ADMIN floor, defuses formula cells, and is audited', async () => {
      const w = await seeded();
      await subscribe(w, { email: 'a@example.com', name: '=cmd|calc', sourceUrl: 'https://acme.test/x' });
      await subscribe(w, { email: 'b@example.com', name: 'Smith, "Jo"' });
      const url = `${base(w)}/lists/${w.listId}/export.csv`;

      const viewer = await memberWith(w, 'APP_ADMIN');
      const refused = await inject({ method: 'GET', url, headers: auth(viewer) });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');

      const admin = await adminOf(w);
      const res = await inject({ method: 'GET', url, headers: auth(admin) });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe('attachment; filename="newsletter-members.csv"');
      const lines = res.body.trim().split('\r\n');
      expect(lines[0]).toBe('email,name,status,source,consentVersion,consentAt,consentIpPrefix,sourceUrl,subscribedAt,unsubscribedAt');
      expect(lines.slice(1).map((l) => l.split(',')[0]).sort()).toEqual(['a@example.com', 'b@example.com']);
      expect(res.body).toContain(`'=cmd|calc`);
      expect(res.body).toContain('"Smith, ""Jo"""');

      const events = await waitForSecurityEvents({ applicationId: w.appId, type: 'app.contacts_exported' });
      expect(events[0]!.metadata).toEqual({ listId: w.listId, key: 'newsletter', count: 2 });
    });
  });
});
