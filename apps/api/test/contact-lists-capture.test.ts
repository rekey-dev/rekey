/**
 * Public capture: GET /api/v1/lists/:key and POST /api/v1/lists/:key/subscribe.
 * Error codes: docs/errors.md, "Lists and contacts".
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { setDeliveryScheduler } from '../src/modules/webhooks/webhook.service.js';
import { writeSubscribe } from '../src/modules/contacts/capture-write.js';
import { CAPTURE_PER_LIST_MINUTE, SERVER_PER_LIST_MINUTE, consumeServerAllowance } from '../src/modules/contacts/capture-limits.js';
import { contactsHarness, type ContactsWorld } from './contacts-fixtures.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

const ORIGIN = 'https://acme.test';

describe('list capture', () => {
  let app: FastifyInstance;
  const h = contactsHarness(() => app, '82');
  const { inject, auth, world, base, createList, mintKey, setIp } = h;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => setDeliveryScheduler(() => undefined));
  afterEach(() => setDeliveryScheduler(null));

  interface Open extends ContactsWorld {
    listId: string;
    secret: string;
  }

  /** A world with origins set and a list open to browsers. */
  async function openWorld(list: Record<string, unknown> = {}): Promise<Open> {
    const w = await world();
    await prisma.application.update({ where: { id: w.appId }, data: { corsOrigins: [ORIGIN] } });
    const created = await createList(w, { lawfulBasis: 'legitimate_interest', ...list });
    expect(created.statusCode, created.body).toBe(201);
    const listId = created.json().data.id as string;
    const opened = await inject({
      method: 'PATCH',
      url: `${base(w)}/lists/${listId}`,
      headers: auth(w.ownerToken),
      payload: { publicCapture: true },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    return { ...w, listId, secret: await mintKey(w) };
  }

  const browser = (w: ContactsWorld, payload: Record<string, unknown>, key = 'newsletter') =>
    inject({
      method: 'POST',
      url: `/api/v1/lists/${key}/subscribe`,
      headers: { authorization: `Bearer ${w.publicKey}`, origin: ORIGIN },
      payload,
    });

  const server = (secret: string, payload: Record<string, unknown>, headers: Record<string, string> = {}, key = 'newsletter') =>
    inject({
      method: 'POST',
      url: `/api/v1/lists/${key}/subscribe`,
      headers: { authorization: `Bearer ${secret}`, ...headers },
      payload,
    });

  const member = (w: Open, email: string) =>
    prisma.contactListMember.findFirst({ where: { listId: w.listId, contact: { email } } });

  describe('the publicCapture gate', () => {
    it('cannot be turned on without a browser origin, and browsers cannot reach a closed list', async () => {
      const w = await world();
      const created = await createList(w);
      const listId = created.json().data.id as string;
      const refused = await inject({
        method: 'PATCH',
        url: `${base(w)}/lists/${listId}`,
        headers: auth(w.ownerToken),
        payload: { publicCapture: true },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('LIST_CAPTURE_UNPROTECTED');
      expect(refused.json().error.fix).toContain('Panel, Access');

      const closed = await inject({
        method: 'GET',
        url: '/api/v1/lists/newsletter',
        headers: { authorization: `Bearer ${w.publicKey}` },
      });
      expect(closed.statusCode).toBe(404);
      expect(closed.json().error.code).toBe('LIST_NOT_FOUND');
      expect(closed.json().error.details).toBeUndefined();
    });

    it('closes again for browsers when the Application loses its origins', async () => {
      const w = await openWorld();
      expect((await browser(w, { email: 'a@example.com' })).statusCode).toBe(202);
      await prisma.application.update({ where: { id: w.appId }, data: { corsOrigins: [] } });
      const res = await inject({
        method: 'POST',
        url: '/api/v1/lists/newsletter/subscribe',
        headers: { authorization: `Bearer ${w.publicKey}` },
        payload: { email: 'b@example.com' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('LIST_NOT_FOUND');
    });

    it('a secret key reaches a closed list, and a missing key lists the live ones', async () => {
      const w = await world();
      await createList(w, { lawfulBasis: 'contract' });
      const secret = await mintKey(w);
      const ok = await server(secret, { email: 'srv@example.com' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().data.status).toBe('subscribed');

      const typo = await server(secret, { email: 'srv@example.com' }, {}, 'newsleter');
      expect(typo.statusCode).toBe(404);
      expect(typo.json().error.details.available).toEqual(['newsletter']);
    });
  });

  it('GET /lists/:key returns the form and the consent version to send back', async () => {
    const w = await openWorld({
      lawfulBasis: 'consent',
      consentText: 'Email me product news.',
      fieldSchema: [{ name: 'company', label: 'Company', type: 'text' }],
    });
    const res = await inject({
      method: 'GET',
      url: '/api/v1/lists/newsletter',
      headers: { authorization: `Bearer ${w.publicKey}`, origin: ORIGIN },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({
      key: 'newsletter',
      name: 'Newsletter',
      kind: 'generic',
      fieldSchema: [{ name: 'company', label: 'Company', type: 'text', required: false, maxLength: 500 }],
      consent: { text: 'Email me product news.', version: 1, lawfulBasis: 'consent' },
    });
  });

  it('answers a browser with the same 202 whatever happened', async () => {
    const w = await openWorld();
    await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { maxContacts: 3 } } });
    await server(w.secret, { email: 'left@example.com' });
    await prisma.contactListMember.updateMany({ where: { listId: w.listId }, data: { status: 'unsubscribed' } });
    await server(w.secret, { email: 'here@example.com' });
    await prisma.emailSuppression.create({ data: { applicationId: w.appId, address: 'bounced@example.com', reason: 'bounce' } });
    await server(w.secret, { email: 'third@example.com' });

    const bodies = new Set<string>();
    const statuses = new Set<number>();
    for (const payload of [
      { email: 'new@example.com' },
      { email: 'here@example.com' },
      { email: 'left@example.com' },
      { email: 'bounced@example.com' },
      { email: 'bot@example.com', hp: 'filled' },
    ]) {
      setIp(`10.82.200.${bodies.size + statuses.size + 1}`);
      const res = await browser(w, payload);
      bodies.add(res.body);
      statuses.add(res.statusCode);
    }
    expect([...statuses]).toEqual([202]);
    expect([...bodies]).toEqual([JSON.stringify({ success: true, data: { status: 'received' } })]);
  });

  it('a browser can never add back someone who unsubscribed; the server can, with consent', async () => {
    const w = await openWorld({ lawfulBasis: 'consent', consentText: 'Yes please.' });
    const consent = { granted: true, version: 1 };
    await browser(w, { email: 'left@example.com', consent });
    await prisma.contactListMember.updateMany({ where: { listId: w.listId }, data: { status: 'unsubscribed', unsubscribedAt: new Date() } });

    expect((await browser(w, { email: 'LEFT@example.com', consent })).statusCode).toBe(202);
    expect((await member(w, 'left@example.com'))!.status).toBe('unsubscribed');

    const back = await server(w.secret, { email: 'left@example.com', consent });
    expect(back.json().data.status).toBe('subscribed');
    const row = (await member(w, 'left@example.com'))!;
    expect(row.status).toBe('subscribed');
    expect(row.unsubscribedAt).toBeNull();
    expect(row.source).toBe('secret');
  });

  it('a secret key without consent on a non-consent list reports previously_unsubscribed and changes nothing', async () => {
    const w = await openWorld();
    await server(w.secret, { email: 'x@example.com' });
    await prisma.contactListMember.updateMany({ where: { listId: w.listId }, data: { status: 'unsubscribed' } });
    const res = await server(w.secret, { email: 'x@example.com' });
    expect(res.json().data.status).toBe('previously_unsubscribed');
    expect((await member(w, 'x@example.com'))!.status).toBe('unsubscribed');
  });

  it('reports each outcome to a secret key', async () => {
    const w = await openWorld();
    const first = await server(w.secret, { email: 'Ada@Example.com', name: 'Ada' });
    expect(first.json().data).toMatchObject({ status: 'subscribed' });
    const contactId = first.json().data.contactId as string;
    expect((await server(w.secret, { email: 'ada@example.com' })).json().data).toEqual({
      status: 'already_subscribed',
      contactId,
    });
    await prisma.emailSuppression.create({ data: { applicationId: w.appId, address: 'gone@example.com', reason: 'complaint' } });
    expect((await server(w.secret, { email: 'gone@example.com' })).json().data).toEqual({ status: 'suppressed', contactId: null });
    expect((await server(w.secret, { email: 'bot@example.com', hp: 'x' })).json().data).toEqual({ status: 'ignored', contactId: null });
    expect(await prisma.contact.findMany({ where: { applicationId: w.appId }, select: { email: true, name: true } })).toEqual([
      { email: 'ada@example.com', name: 'Ada' },
    ]);
  });

  it('a browser fills in a missing name but never overwrites one; a server does', async () => {
    const w = await openWorld();
    await browser(w, { email: 'n@example.com' });
    await browser(w, { email: 'n@example.com', name: 'First' });
    await browser(w, { email: 'n@example.com', name: 'Hijack' });
    const name = async () => (await prisma.contact.findFirstOrThrow({ where: { applicationId: w.appId } })).name;
    expect(await name()).toBe('First');
    await server(w.secret, { email: 'n@example.com', name: 'Server' });
    expect(await name()).toBe('Server');
  });

  it('a notification-only suppression (one-click unsubscribe) does not block a list', async () => {
    const w = await openWorld();
    await prisma.emailSuppression.create({
      data: { applicationId: w.appId, address: 'n@example.com', reason: 'unsubscribe', category: 'notification' },
    });
    expect((await server(w.secret, { email: 'n@example.com' })).json().data.status).toBe('subscribed');
  });

  describe('a secret key relaying a browser (it names the visitor)', () => {
    const visitor = { 'x-rekey-client-ip': '198.51.100.20' };

    it('gets the constant 202 and cannot add back someone who left, even with consent', async () => {
      const w = await openWorld({ lawfulBasis: 'consent', consentText: 'Yes please.' });
      const consent = { granted: true, version: 1 };
      await server(w.secret, { email: 'left@example.com', consent });
      await prisma.contactListMember.updateMany({ where: { listId: w.listId }, data: { status: 'unsubscribed', unsubscribedAt: new Date() } });

      const relayed = await server(w.secret, { email: 'left@example.com', consent }, visitor);
      expect(relayed.statusCode).toBe(202);
      expect(relayed.body).toBe(JSON.stringify({ success: true, data: { status: 'received' } }));
      expect((await member(w, 'left@example.com'))!.status).toBe('unsubscribed');
    });

    it('cannot rename a contact who already has a name', async () => {
      const w = await openWorld();
      await server(w.secret, { email: 'n@example.com', name: 'Real Name' });
      await server(w.secret, { email: 'n@example.com', name: 'Hijack' }, visitor);
      expect((await prisma.contact.findFirstOrThrow({ where: { applicationId: w.appId } })).name).toBe('Real Name');
    });

    it('the relay marker alone, with no visitor address, gets browser semantics', async () => {
      const w = await openWorld({ lawfulBasis: 'consent', consentText: 'Yes please.' });
      const consent = { granted: true, version: 1 };
      await server(w.secret, { email: 'left@example.com', name: 'Real Name', consent });
      await prisma.contactListMember.updateMany({ where: { listId: w.listId }, data: { status: 'unsubscribed', unsubscribedAt: new Date() } });

      const marker = { 'x-rekey-relay': 'browser' };
      const res = await server(w.secret, { email: 'left@example.com', name: 'Hijack', consent }, marker);
      expect(res.statusCode).toBe(202);
      expect(res.body).toBe(JSON.stringify({ success: true, data: { status: 'received' } }));
      expect((await member(w, 'left@example.com'))!.status).toBe('unsubscribed');
      expect((await prisma.contact.findFirstOrThrow({ where: { applicationId: w.appId } })).name).toBe('Real Name');

      const codes: number[] = [];
      for (let i = 0; i < CAPTURE_PER_LIST_MINUTE + 1; i++) {
        codes.push((await server(w.secret, { email: `r${i}@example.com`, consent }, marker)).statusCode);
      }
      expect(codes.at(-1)).toBe(429);
    });

    it('is dropped silently over maxContacts, like a browser', async () => {
      const w = await openWorld();
      await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { maxContacts: 0 } } });
      const res = await server(w.secret, { email: 'new@example.com' }, visitor);
      expect(res.statusCode).toBe(202);
      expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(0);
    });
  });

  describe('suppressions', () => {
    it('any suppression, a notification opt-out included, blocks a browser but not your own server', async () => {
      const w = await openWorld();
      await prisma.emailSuppression.create({
        data: { applicationId: w.appId, address: 'optout@example.com', reason: 'unsubscribe', category: 'notification' },
      });
      expect((await browser(w, { email: 'OptOut@example.com' })).statusCode).toBe(202);
      expect((await server(w.secret, { email: 'optout@example.com' }, { 'x-rekey-client-ip': '198.51.100.21' })).statusCode).toBe(202);
      expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(0);
      expect((await server(w.secret, { email: 'optout@example.com' })).json().data.status).toBe('subscribed');
    });
  });

  describe('consent', () => {
    it('is required on a consent list, and must name the current version', async () => {
      const w = await openWorld({ lawfulBasis: 'consent', consentText: 'v1 text' });
      const missing = await browser(w, { email: 'c@example.com' });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.code).toBe('CONTACT_CONSENT_REQUIRED');
      expect(missing.json().error.fix).toContain('version: 1');

      await inject({
        method: 'PATCH',
        url: `${base(w)}/lists/${w.listId}`,
        headers: auth(w.ownerToken),
        payload: { consentText: 'v2 text' },
      });
      const stale = await browser(w, { email: 'c@example.com', consent: { granted: true, version: 1 } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('CONTACT_CONSENT_STALE');
      expect(stale.json().error.details).toEqual({ currentVersion: 2 });

      const ok = await browser(w, { email: 'c@example.com', consent: { granted: true, version: 2 }, sourceUrl: 'https://acme.test/join?ref=secret#top' });
      expect(ok.statusCode).toBe(202);
      const row = (await member(w, 'c@example.com'))!;
      expect(row.consentVersion).toBe(2);
      expect(row.consentAt).not.toBeNull();
      expect(row.consentIpPrefix).toMatch(/^10\.82\.\d+\.0\/24$/);
      expect(row.sourceUrl).toBe('https://acme.test/join');
      expect(row.source).toBe('publishable');
    });
  });

  describe('fields', () => {
    const schema = [
      { name: 'message', label: 'Message', type: 'textarea', required: true, maxLength: 20 },
      { name: 'plan', label: 'Plan', type: 'select', options: ['solo', 'team'] },
      { name: 'seats', label: 'Seats', type: 'number' },
    ];

    it('reports every problem at once', async () => {
      const w = await openWorld({ fieldSchema: schema });
      const res = await server(w.secret, { email: 'f@example.com', fields: { plan: 'enterprise', seats: 'lots', extra: 'x' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CONTACT_FIELDS_INVALID');
      expect(res.json().error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual([
        'fields.extra',
        'fields.message',
        'fields.plan',
        'fields.seats',
      ]);
    });

    it('reads a checkbox the way an HTML form posts it', async () => {
      const w = await openWorld({ fieldSchema: [{ name: 'beta', label: 'Beta', type: 'checkbox' }] });
      await server(w.secret, { email: 'on@example.com', fields: { beta: 'on' } });
      await server(w.secret, { email: 'off@example.com', fields: { beta: 'false' } });
      const bad = await server(w.secret, { email: 'x@example.com', fields: { beta: 'maybe' } });
      expect(bad.statusCode).toBe(400);
      const stored = await prisma.contactSubmission.findMany({ where: { listId: w.listId }, orderBy: { createdAt: 'asc' } });
      expect(stored.map((s) => s.fields)).toEqual([{ beta: true }, { beta: false }]);
    });

    it('stores a submission and enqueues both webhooks in the write', async () => {
      const w = await openWorld({ fieldSchema: schema });
      await prisma.webhookEndpoint.create({
        data: { applicationId: w.appId, url: 'https://127.0.0.1:1/never', secret: 'whsec_lists', events: ['*'], enabled: true },
      });
      const res = await server(w.secret, { email: 'f@example.com', fields: { message: ' hello ', plan: 'team', seats: '3' } });
      expect(res.json().data.status).toBe('subscribed');
      const submissions = await prisma.contactSubmission.findMany({ where: { listId: w.listId } });
      expect(submissions.map((s) => s.fields)).toEqual([{ message: 'hello', plan: 'team', seats: 3 }]);
      const deliveries = await prisma.webhookDelivery.findMany({ where: { applicationId: w.appId }, orderBy: { eventType: 'asc' } });
      expect(deliveries.map((d) => d.eventType)).toEqual(['contact.submission.created', 'contact.subscribed']);
      const payload = deliveries[0]!.payload as { data: { contact: { id: string }; submission: { fields: unknown } } };
      expect(payload.data.contact.id).toBe(res.json().data.contactId);
      expect(payload.data.submission.fields).toEqual({ message: 'hello', plan: 'team', seats: 3 });

      await server(w.secret, { email: 'f@example.com' });
      expect(await prisma.webhookDelivery.count({ where: { applicationId: w.appId } })).toBe(2);
    });
  });

  it('refuses disposable domains unless the list allows them', async () => {
    const w = await openWorld();
    const res = await server(w.secret, { email: 'x@mailinator.com' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CONTACT_EMAIL_DOMAIN_NOT_ALLOWED');
    await inject({
      method: 'PATCH',
      url: `${base(w)}/lists/${w.listId}`,
      headers: auth(w.ownerToken),
      payload: { blockDisposable: false },
    });
    expect((await server(w.secret, { email: 'x@mailinator.com' })).statusCode).toBe(200);
  });

  describe('rate limits', () => {
    it('holds a browser to 5 a minute per address', async () => {
      const w = await openWorld();
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await browser(w, { email: `r${i}@example.com` })).statusCode);
      expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
      const last = await browser(w, { email: 'r9@example.com' });
      expect(last.json().error.code).toBe('CONTACTS_RATE_LIMITED');
      expect(last.json().error.retryAfterSeconds).toBeGreaterThan(0);
      expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(5);
    });

    it('a server backfilling on its own behalf is not held; one naming the visitor is', async () => {
      const w = await openWorld();
      await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { contactCaptureDailyCap: 7 } } });
      for (let i = 0; i < 8; i++) expect((await server(w.secret, { email: `s${i}@example.com` })).statusCode).toBe(200);
      const visitor = { 'x-rekey-client-ip': '198.51.100.7' };
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await server(w.secret, { email: `v${i}@example.com` }, visitor)).statusCode);
      expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
      const row = (await member(w, 'v0@example.com'))!;
      expect(row.consentIpPrefix).toBeNull();
    });

    it('a server with no visitor address still has a per-list ceiling', async () => {
      const w = await openWorld();
      const now = Date.now();
      for (let i = 0; i < SERVER_PER_LIST_MINUTE; i++) await consumeServerAllowance(w.listId, now);
      await expect(consumeServerAllowance(w.listId, now)).rejects.toMatchObject({ code: 'CONTACTS_RATE_LIMITED' });
      await expect(consumeServerAllowance('another-list', now)).resolves.toBeUndefined();
    });

    it('the workspace daily cap refuses browsers once spent', async () => {
      const w = await openWorld();
      await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { contactCaptureDailyCap: 2 } } });
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        setIp(`10.82.201.${i + 1}`);
        codes.push((await browser(w, { email: `d${i}@example.com` })).statusCode);
      }
      expect(codes).toEqual([202, 202, 429]);
    });
  });

  describe('maxContacts', () => {
    it('counts only new contacts, refuses a secret key, and tells the operator when a browser is dropped', async () => {
      const w = await openWorld();
      await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { maxContacts: 1 } } });
      expect((await server(w.secret, { email: 'one@example.com' })).statusCode).toBe(200);

      const over = await server(w.secret, { email: 'two@example.com' });
      expect(over.statusCode).toBe(403);
      expect(over.json().error.code).toBe('CONTACT_QUOTA_EXCEEDED');

      await createList(w, { key: 'waitlist', name: 'Waitlist', lawfulBasis: 'contract' });
      const existing = await server(w.secret, { email: 'one@example.com' }, {}, 'waitlist');
      expect(existing.json().data.status).toBe('subscribed');

      const dropped = await browser(w, { email: 'three@example.com' });
      expect(dropped.statusCode).toBe(202);
      expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(1);
      const events = await waitForSecurityEvents({ applicationId: w.appId, type: 'app.contact_quota_reached' });
      expect(events[0]!.metadata).toEqual({ listKey: 'newsletter' });
    });
  });

  it('holds maxContacts exactly: a subscribe waits for one still being written before it counts', async () => {
    const w = await openWorld();
    await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { maxContacts: 1 } } });
    const list = await prisma.contactList.findUniqueOrThrow({ where: { id: w.listId } });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contacts:${w.tenantId}`}))`;
      await tx.contact.create({ data: { applicationId: w.appId, email: 'first@example.com' } });
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    const second = writeSubscribe({
      tenantId: w.tenantId,
      list,
      email: 'second@example.com',
      name: undefined,
      fields: {},
      authoritative: true,
      source: 'secret',
      consent: undefined,
      consentIpPrefix: null,
      sourceUrl: null,
      maxContacts: 1,
    });
    await new Promise((r) => setTimeout(r, 100));
    release();
    await first;
    await expect(second).rejects.toMatchObject({ code: 'CONTACT_QUOTA_EXCEEDED' });
    expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(1);
  });

  it('8 concurrent new addresses at maxContacts - 1 end at maxContacts', async () => {
    const w = await openWorld();
    await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { maxContacts: 3 } } });
    await server(w.secret, { email: 'one@example.com' });
    await server(w.secret, { email: 'two@example.com' });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => server(w.secret, { email: `race${i}@example.com` })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(7);
    expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(3);
  });

  it('8 concurrent subscribes of one new address store one contact and one member', async () => {
    const w = await openWorld();
    await prisma.webhookEndpoint.create({
      data: { applicationId: w.appId, url: 'https://127.0.0.1:1/never', secret: 'whsec_race', events: ['contact.subscribed'], enabled: true },
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => server(w.secret, { email: 'race@example.com' })));
    const statuses = results.map((r) => r.json().data.status as string).sort();
    expect(statuses).toEqual(['already_subscribed', ...Array(6).fill('already_subscribed'), 'subscribed'].sort());
    expect(await prisma.contact.count({ where: { applicationId: w.appId } })).toBe(1);
    expect(await prisma.contactListMember.count({ where: { listId: w.listId } })).toBe(1);
    expect(await prisma.webhookDelivery.count({ where: { applicationId: w.appId } })).toBe(1);
  });

  it('a secret key without contacts:write is refused', async () => {
    const w = await openWorld();
    const narrow = await mintKey(w, ['auth:read']);
    const res = await server(narrow, { email: 'n@example.com' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
    const scoped = await mintKey(w, ['contacts:write']);
    expect((await server(scoped, { email: 'n@example.com' })).statusCode).toBe(200);
  });

  it('an archived list refuses every subscribe', async () => {
    const w = await openWorld();
    await inject({ method: 'POST', url: `${base(w)}/lists/${w.listId}/archive`, headers: auth(w.ownerToken) });
    expect((await server(w.secret, { email: 'a@example.com' })).statusCode).toBe(404);
    expect((await browser(w, { email: 'a@example.com' })).statusCode).toBe(404);
  });
});
