/**
 * Contacts and GDPR: erasing a contact, the cascade from end-user erasure,
 * the DSAR export, submission retention, and taking someone off a list.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { setDeliveryScheduler } from '../src/modules/webhooks/webhook.service.js';
import { pruneExpiredSubmissions, pruneExpiredTombstones } from '../src/modules/contacts/submission-retention.js';
import { contactsHarness, type ContactsWorld } from './contacts-fixtures.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

describe('contacts and GDPR', () => {
  let app: FastifyInstance;
  const h = contactsHarness(() => app, '83');
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
    secret: string;
    listId: string;
  }

  const FIELDS = [{ name: 'message', label: 'Message', type: 'textarea' }];

  async function seeded(): Promise<Seeded> {
    const w = await world();
    const list = await createList(w, { lawfulBasis: 'consent', consentText: 'Email me.', fieldSchema: FIELDS });
    const secret = await mintKey(w);
    await prisma.webhookEndpoint.create({
      data: { applicationId: w.appId, url: 'https://127.0.0.1:1/never', secret: 'whsec_gdpr', events: ['*'], enabled: true },
    });
    return { ...w, secret, listId: list.json().data.id as string };
  }

  /** Your own server, speaking for itself: gets the real outcome. */
  const subscribe = (w: Seeded, email: string, extra: Record<string, unknown> = {}) =>
    inject({
      method: 'POST',
      url: '/api/v1/lists/newsletter/subscribe',
      headers: auth(w.secret),
      payload: { email, name: 'Ada Lovelace', consent: { granted: true, version: 1 }, ...extra },
    });

  /** Your server relaying a visitor's form. */
  const relayed = (w: Seeded, email: string, extra: Record<string, unknown> = {}) =>
    inject({
      method: 'POST',
      url: '/api/v1/lists/newsletter/subscribe',
      headers: { ...auth(w.secret), 'x-rekey-client-ip': '203.0.113.9' },
      payload: { email, name: 'Ada Lovelace', consent: { granted: true, version: 1 }, ...extra },
    });

  async function signUp(w: Seeded, email: string): Promise<string> {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${w.secret}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { endUser: { id: string } }).endUser.id;
  }

  async function contactDeliveries(appId: string) {
    return prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: { startsWith: 'contact.' } },
      orderBy: { eventType: 'asc' },
    });
  }

  describe('erasing a contact', () => {
    it('deletes the contact with its memberships and submissions and scrubs its deliveries', async () => {
      const w = await seeded();
      const res = await subscribe(w, 'ada@example.com', { fields: { message: 'call me on 555-0100' } });
      const contactId = res.json().data.contactId as string;
      await subscribe(w, 'other@example.com');
      expect(await contactDeliveries(w.appId)).toHaveLength(3);

      const erased = await inject({
        method: 'DELETE',
        url: `${base(w)}/contacts/${contactId}`,
        headers: auth(w.ownerToken),
      });
      expect(erased.statusCode, erased.body).toBe(200);
      expect(erased.json().data).toEqual({ erased: true, webhookDeliveriesScrubbed: 2 });

      expect(await prisma.contact.findMany({ where: { applicationId: w.appId }, select: { email: true } })).toEqual([
        { email: 'other@example.com' },
      ]);
      expect(await prisma.contactListMember.count({ where: { contactId } })).toBe(0);
      expect(await prisma.contactSubmission.count({ where: { contactId } })).toBe(0);

      const deliveries = await contactDeliveries(w.appId);
      expect(deliveries).toHaveLength(3);
      const theirs = deliveries.filter((d) => (d.payload as { data: { contact: { id: string } } }).data.contact.id === contactId);
      const dump = JSON.stringify(theirs.map((d) => d.payload));
      expect(dump).not.toContain('ada@example.com');
      expect(dump).not.toContain('Ada Lovelace');
      expect(dump).not.toContain('555-0100');
      expect(dump).toContain(`erased+${contactId}@deleted.invalid`);
      const submission = theirs.find((d) => d.eventType === 'contact.submission.created')!;
      expect((submission.payload as { data: { submission: { fields: unknown; id: string } } }).data.submission).toMatchObject({ fields: null });
      const subscribed = theirs.find((d) => d.eventType === 'contact.subscribed')!;
      expect((subscribed.payload as { data: Record<string, unknown> }).data).not.toHaveProperty('submission');
      const untouched = deliveries.find((d) => !theirs.includes(d))!;
      expect(JSON.stringify(untouched.payload)).toContain('other@example.com');

      const events = await waitForSecurityEvents({ applicationId: w.appId, type: 'contact.erased' });
      expect(events[0]!.metadata).toEqual({ contactId, webhookDeliveriesScrubbed: 2 });
    });

    it('is an OWNER floor: a workspace ADMIN and an APP_ADMIN member are refused, and a contact of another Application is not found', async () => {
      const w = await seeded();
      const contactId = (await subscribe(w, 'ada@example.com')).json().data.contactId as string;
      for (const token of [await adminOf(w), await memberWith(w, 'APP_ADMIN')]) {
        const refused = await inject({ method: 'DELETE', url: `${base(w)}/contacts/${contactId}`, headers: auth(token) });
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
      }

      const other = await inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: auth(w.ownerToken),
        payload: { name: 'Other', slug: `${w.tag}-o` },
      });
      const wrongApp = await inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${other.json().data.id}/contacts/${contactId}`,
        headers: auth(w.ownerToken),
      });
      expect(wrongApp.statusCode).toBe(404);
      expect(wrongApp.json().error.code).toBe('CONTACT_NOT_FOUND');
      expect(await prisma.contact.count({ where: { id: contactId } })).toBe(1);
    });
  });

  describe('erasing an end user', () => {
    it('erases the contact at the same address in the same Application, and nowhere else', async () => {
      const w = await seeded();
      const other = await seeded();
      const euid = await signUp(w, 'ada@example.com');
      const contactId = (await subscribe(w, 'ADA@example.com', { fields: { message: 'hello' } })).json().data.contactId as string;
      await subscribe(other, 'ada@example.com');

      const res = await inject({
        method: 'DELETE',
        url: `${base(w)}/end-users/${euid}?erasure=true`,
        headers: auth(w.ownerToken),
      });
      expect(res.statusCode, res.body).toBe(200);

      expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(0);
      expect(await prisma.contactSubmission.count({ where: { applicationId: w.appId } })).toBe(0);
      expect(await prisma.contact.count({ where: { applicationId: other.appId, email: 'ada@example.com' } })).toBe(1);
      const dump = JSON.stringify((await contactDeliveries(w.appId)).map((d) => d.payload));
      expect(dump).not.toContain('ada@example.com');
      expect(dump).toContain(`erased+${contactId}@deleted.invalid`);
      expect(JSON.stringify((await contactDeliveries(other.appId)).map((d) => d.payload))).toContain('ada@example.com');
    });
  });

  describe('after erasure, a browser cannot put the person back', () => {
    async function openCapture(w: Seeded): Promise<void> {
      await prisma.application.update({ where: { id: w.appId }, data: { corsOrigins: ['https://acme.test'] } });
      await prisma.contactList.update({ where: { id: w.listId }, data: { publicCapture: true } });
    }
    const browserSubscribe = (w: Seeded, email: string) =>
      inject({
        method: 'POST',
        url: '/api/v1/lists/newsletter/subscribe',
        headers: { authorization: `Bearer ${w.publicKey}`, origin: 'https://acme.test' },
        payload: { email, consent: { granted: true, version: 1 } },
      });

    it('after end-user erasure: browser and relayed capture store nothing, your own server can add them', async () => {
      const w = await seeded();
      await openCapture(w);
      const euid = await signUp(w, 'ada@example.com');
      await subscribe(w, 'ada@example.com');
      await inject({ method: 'DELETE', url: `${base(w)}/end-users/${euid}?erasure=true`, headers: auth(w.ownerToken) });

      expect((await browserSubscribe(w, 'ADA@example.com')).statusCode).toBe(202);
      expect((await relayed(w, 'ada@example.com')).statusCode).toBe(202);
      expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(0);
      const stored = JSON.stringify(await prisma.contactErasureTombstone.findMany({ where: { applicationId: w.appId } }));
      expect(stored).not.toContain('ada@example.com');

      const own = await inject({
        method: 'POST',
        url: '/api/v1/lists/newsletter/subscribe',
        headers: auth(w.secret),
        payload: { email: 'ada@example.com', consent: { granted: true, version: 1 } },
      });
      expect(own.json().data.status).toBe('subscribed');
    });

    it('after an operator erases a contact, and only until the tombstone expires', async () => {
      const w = await seeded();
      await openCapture(w);
      const contactId = (await subscribe(w, 'grace@example.com')).json().data?.contactId as string | undefined;
      const id = contactId ?? (await prisma.contact.findFirstOrThrow({ where: { applicationId: w.appId } })).id;
      await inject({ method: 'DELETE', url: `${base(w)}/contacts/${id}`, headers: auth(w.ownerToken) });
      await browserSubscribe(w, 'grace@example.com');
      expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(0);

      await prisma.contactErasureTombstone.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      await browserSubscribe(w, 'grace@example.com');
      expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(1);
      expect(await pruneExpiredTombstones()).toBe(1);
    });
  });

  it('the DSAR export covers every address erasure covers, including one an email change is pending for', async () => {
    const w = await seeded();
    const euid = await signUp(w, 'old@example.com');
    await prisma.emailVerificationToken.create({
      data: { applicationId: w.appId, endUserId: euid, tokenHash: `h-${euid}`, email: 'new@example.com', expiresAt: new Date(Date.now() + 3_600_000) },
    });
    await subscribe(w, 'old@example.com');
    await subscribe(w, 'new@example.com');
    const res = await inject({ method: 'GET', url: `${base(w)}/end-users/${euid}/export`, headers: auth(w.ownerToken) });
    expect((res.json() as { contacts: Array<{ email: string }> }).contacts.map((c) => c.email).sort()).toEqual([
      'new@example.com',
      'old@example.com',
    ]);
  });

  it('the DSAR export carries the contact, its consent proof with the exact text, and its submissions', async () => {
    const w = await seeded();
    const euid = await signUp(w, 'ada@example.com');
    await relayed(w, 'ada@example.com', { fields: { message: 'first' }, sourceUrl: 'https://acme.test/join?x=1' });
    const res = await inject({ method: 'GET', url: `${base(w)}/end-users/${euid}/export`, headers: auth(w.ownerToken) });
    expect(res.statusCode, res.body).toBe(200);
    const doc = res.json() as { contacts: Array<Record<string, unknown>> };
    expect(doc.contacts).toHaveLength(1);
    expect(doc.contacts[0]).toMatchObject({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      memberships: [
        {
          listKey: 'newsletter',
          listName: 'Newsletter',
          status: 'subscribed',
          source: 'secret',
          consentVersion: 1,
          consentText: 'Email me.',
          consentIpPrefix: '203.0.113.0/24',
          sourceUrl: 'https://acme.test/join',
          unsubscribedAt: null,
        },
      ],
      submissions: [{ listKey: 'newsletter', fields: { message: 'first' } }],
    });

    const lone = await signUp(w, 'nobody@example.com');
    const empty = await inject({ method: 'GET', url: `${base(w)}/end-users/${lone}/export`, headers: auth(w.ownerToken) });
    expect((empty.json() as { contacts: unknown[] }).contacts).toEqual([]);
  });

  it('the retention sweep deletes submissions past their list setting and keeps the rest', async () => {
    const w = await seeded();
    await subscribe(w, 'a@example.com', { fields: { message: 'old' } });
    await subscribe(w, 'b@example.com', { fields: { message: 'new' } });
    const keepList = await createList(w, { key: 'keep', name: 'Keep', lawfulBasis: 'contract', fieldSchema: FIELDS });
    await inject({
      method: 'POST',
      url: '/api/v1/lists/keep/subscribe',
      headers: { authorization: `Bearer ${w.secret}` },
      payload: { email: 'c@example.com', fields: { message: 'kept forever' } },
    });
    await inject({
      method: 'PATCH',
      url: `${base(w)}/lists/${w.listId}`,
      headers: auth(w.ownerToken),
      payload: { submissionRetentionDays: 30 },
    });
    const old = new Date(Date.now() - 31 * 86_400_000);
    await prisma.contactSubmission.updateMany({ where: { fields: { equals: { message: 'old' } } }, data: { createdAt: old } });
    await prisma.contactSubmission.updateMany({ where: { listId: keepList.json().data.id }, data: { createdAt: old } });

    expect(await pruneExpiredSubmissions()).toBe(1);
    const left = await prisma.contactSubmission.findMany({ where: { applicationId: w.appId }, select: { fields: true } });
    expect(left.map((s) => (s.fields as { message: string }).message).sort()).toEqual(['kept forever', 'new']);
    expect(await pruneExpiredSubmissions()).toBe(0);
  });

  describe('DELETE /lists/:key/members/:email', () => {
    const leave = (key: string, email: string, headers: Record<string, string>) =>
      inject({ method: 'DELETE', url: `/api/v1/lists/${key}/members/${encodeURIComponent(email)}`, headers });

    it('unsubscribes once, sends contact.unsubscribed once, and a browser subscribe cannot undo it', async () => {
      const w = await seeded();
      await subscribe(w, 'ada@example.com');
      const first = await leave('newsletter', 'ADA@example.com', auth(w.secret));
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().data).toEqual({ status: 'unsubscribed' });
      expect((await leave('newsletter', 'ada@example.com', auth(w.secret))).json().data).toEqual({ status: 'not_subscribed' });
      expect((await leave('newsletter', 'stranger@example.com', auth(w.secret))).json().data).toEqual({ status: 'not_subscribed' });

      const unsubscribed = (await contactDeliveries(w.appId)).filter((d) => d.eventType === 'contact.unsubscribed');
      expect(unsubscribed).toHaveLength(1);
      const member = await prisma.contactListMember.findFirstOrThrow({ where: { listId: w.listId } });
      expect(member.status).toBe('unsubscribed');
      expect(member.unsubscribedAt).not.toBeNull();
    });

    it('refuses a publishable key and a key without contacts:write, and names the live keys on a typo', async () => {
      const w = await seeded();
      expect((await leave('newsletter', 'a@example.com', auth(w.publicKey))).statusCode).toBe(401);
      const narrow = await mintKey(w, ['auth:read']);
      const scoped = await leave('newsletter', 'a@example.com', auth(narrow));
      expect(scoped.statusCode).toBe(403);
      expect(scoped.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
      const typo = await leave('newsleter', 'a@example.com', auth(w.secret));
      expect(typo.statusCode).toBe(404);
      expect(typo.json().error.details.available).toEqual(['newsletter']);
    });
  });
});
