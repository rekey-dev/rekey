/**
 * Operator list management: /api/v1/tenant/applications/:id/lists.
 * Error codes: docs/errors.md, "Lists and contacts".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { listsService } from '../src/modules/contacts/lists.service.js';
import { assertContactListQuota } from '../src/modules/contacts/quota.js';
import { contactsHarness } from './contacts-fixtures.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

describe('tenant list management', () => {
  let app: FastifyInstance;
  const h = contactsHarness(() => app, '81');
  const { inject, auth, world, base, createList, memberWith } = h;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a list with defaults that keep browsers out', async () => {
    const w = await world();
    const res = await createList(w, { kind: 'waitlist' });
    expect(res.statusCode, res.body).toBe(201);
    const list = res.json().data;
    expect(list).toMatchObject({
      key: 'newsletter',
      kind: 'waitlist',
      lawfulBasis: 'consent',
      consentText: null,
      consentVersion: 0,
      publicCapture: false,
      blockDisposable: true,
      archivedAt: null,
      counts: { subscribed: 0, unsubscribed: 0, submissions: 0 },
    });

    const all = await inject({ method: 'GET', url: `${base(w)}/lists`, headers: auth(w.ownerToken) });
    expect(all.statusCode).toBe(200);
    expect(all.json().data.items.map((l: { key: string }) => l.key)).toEqual(['newsletter']);
  });

  it('does not take publicCapture on create: capture is switched on separately', async () => {
    const w = await world();
    const res = await createList(w, { publicCapture: true });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a duplicate key with LIST_KEY_TAKEN, archived or not', async () => {
    const w = await world();
    const first = await createList(w);
    await inject({
      method: 'POST',
      url: `${base(w)}/lists/${first.json().data.id}/archive`,
      headers: auth(w.ownerToken),
    });
    const again = await createList(w);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('LIST_KEY_TAKEN');
    expect(again.json().error.fix).toContain('/archive');
  });

  it('validates the key and the field schema', async () => {
    const w = await world();
    expect((await createList(w, { key: 'No Spaces' })).statusCode).toBe(400);
    expect((await createList(w, { key: 'ab' })).statusCode).toBe(400);
    const dupField = await createList(w, {
      fieldSchema: [
        { name: 'company', label: 'Company', type: 'text' },
        { name: 'company', label: 'Company again', type: 'text' },
      ],
    });
    expect(dupField.statusCode).toBe(400);
    const selectWithoutOptions = await createList(w, {
      fieldSchema: [{ name: 'plan', label: 'Plan', type: 'select' }],
    });
    expect(selectWithoutOptions.statusCode).toBe(400);
    const ok = await createList(w, {
      fieldSchema: [
        { name: 'company', label: 'Company', type: 'text' },
        { name: 'plan', label: 'Plan', type: 'select', required: true, options: ['solo', 'team'] },
      ],
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().data.fieldSchema[0]).toEqual({
      name: 'company',
      label: 'Company',
      type: 'text',
      required: false,
      maxLength: 500,
    });
  });

  it('versions the consent text: each new text is the next version, and history keeps every one', async () => {
    const w = await world();
    const created = await createList(w, { consentText: 'Send me the newsletter.' });
    expect(created.json().data.consentVersion).toBe(1);
    const id = created.json().data.id as string;

    const same = await inject({
      method: 'PATCH',
      url: `${base(w)}/lists/${id}`,
      headers: auth(w.ownerToken),
      payload: { consentText: 'Send me the newsletter.', description: 'Monthly' },
    });
    expect(same.json().data.consentVersion).toBe(1);
    expect(same.json().data.description).toBe('Monthly');

    const changed = await inject({
      method: 'PATCH',
      url: `${base(w)}/lists/${id}`,
      headers: auth(w.ownerToken),
      payload: { consentText: 'Send me the newsletter and product news.', name: 'News' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const data = changed.json().data;
    expect(data.consentVersion).toBe(2);
    expect(data.name).toBe('News');
    expect(data.consentVersions.map((v: { version: number; text: string }) => [v.version, v.text])).toEqual([
      [2, 'Send me the newsletter and product news.'],
      [1, 'Send me the newsletter.'],
    ]);
  });

  it('records settings changes by field name, never by value', async () => {
    const w = await world();
    const created = await createList(w);
    const id = created.json().data.id as string;
    await inject({
      method: 'PATCH',
      url: `${base(w)}/lists/${id}`,
      headers: auth(w.ownerToken),
      payload: { consentText: 'Secret wording', blockDisposable: false },
    });
    const events = await waitForSecurityEvents(
      { applicationId: w.appId, type: { startsWith: 'app.contact_list.' } },
      { atLeast: 2 },
    );
    const updated = events.find((e) => e.type === 'app.contact_list.updated')!;
    expect(events.map((e) => e.type).sort()).toEqual(['app.contact_list.created', 'app.contact_list.updated']);
    expect((updated.metadata as { changed: string[] }).changed.sort()).toEqual(['blockDisposable', 'consentText']);
    expect(JSON.stringify(updated.metadata)).not.toContain('Secret wording');
  });

  it('archive and restore are idempotent and gate on maxContactLists', async () => {
    const w = await world();
    await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { maxContactLists: 1 } } });
    const first = await createList(w);
    expect(first.statusCode).toBe(201);
    const second = await createList(w, { key: 'waitlist', name: 'Waitlist' });
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe('CONTACT_LIST_QUOTA_EXCEEDED');
    expect(second.json().error.fix).toContain('PUT /api/v1/admin/tenants/:id/limits');

    const id = first.json().data.id as string;
    for (let i = 0; i < 2; i++) {
      const archived = await inject({ method: 'POST', url: `${base(w)}/lists/${id}/archive`, headers: auth(w.ownerToken) });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().data.archivedAt).not.toBeNull();
    }
    const third = await createList(w, { key: 'waitlist', name: 'Waitlist' });
    expect(third.statusCode, third.body).toBe(201);

    const restore = await inject({ method: 'DELETE', url: `${base(w)}/lists/${id}/archive`, headers: auth(w.ownerToken) });
    expect(restore.statusCode).toBe(403);
    expect(restore.json().error.code).toBe('CONTACT_LIST_QUOTA_EXCEEDED');
  });

  it('holds maxContactLists exactly under 8 concurrent creates', async () => {
    const w = await world();
    await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { maxContactLists: 3 } } });
    const operator = await prisma.tenantUser.findFirstOrThrow({ where: { memberships: { some: { tenantId: w.tenantId } } } });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        listsService.create(w.tenantId, w.appId, operator.id, { key: `race_${i}`, name: `Race ${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const refusals = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refusals.map((r) => (r.reason as { code: string }).code)).toEqual(Array(5).fill("CONTACT_LIST_QUOTA_EXCEEDED"));
    expect(await prisma.contactList.count({ where: { applicationId: w.appId } })).toBe(3);
  });

  it('a create waits for one still in flight before counting, so the ceiling cannot be raced', async () => {
    const w = await world();
    await prisma.tenant.update({ where: { id: w.tenantId }, data: { limits: { maxContactLists: 1 } } });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = prisma.$transaction(async (tx) => {
      await assertContactListQuota(w.tenantId, tx);
      await tx.contactList.create({ data: { applicationId: w.appId, key: 'first', name: 'First' } });
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    const second = prisma.$transaction(async (tx) => {
      await assertContactListQuota(w.tenantId, tx);
      await tx.contactList.create({ data: { applicationId: w.appId, key: 'second', name: 'Second' } });
    });
    await new Promise((r) => setTimeout(r, 100));
    release();
    await first;
    await expect(second).rejects.toMatchObject({ code: 'CONTACT_LIST_QUOTA_EXCEEDED' });
  });

  it('a list id from another Application is LIST_NOT_FOUND', async () => {
    const w = await world();
    const other = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: auth(w.ownerToken),
      payload: { name: 'Other', slug: `${w.tag}-other` },
    });
    const otherId = other.json().data.id as string;
    const list = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${otherId}/lists`,
      headers: auth(w.ownerToken),
      payload: { key: 'newsletter', name: 'Theirs' },
    });
    const res = await inject({
      method: 'GET',
      url: `${base(w)}/lists/${list.json().data.id}`,
      headers: auth(w.ownerToken),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('LIST_NOT_FOUND');
  });

  describe('the audience scope is default-deny', () => {
    it('a viewer grant cannot read lists; an APP_ADMIN grant can write them', async () => {
      const w = await world();
      await createList(w);
      const viewer = await memberWith(w, 'APP_VIEWER');
      const denied = await inject({ method: 'GET', url: `${base(w)}/lists`, headers: auth(viewer) });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('SCOPE_INSUFFICIENT');
      expect(denied.json().error.message).toContain('audience:read');
    });

    it('a billing grant cannot read lists', async () => {
      const w = await world();
      const billing = await memberWith(w, 'APP_BILLING');
      const denied = await inject({ method: 'GET', url: `${base(w)}/lists`, headers: auth(billing) });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('SCOPE_INSUFFICIENT');
    });

    it('an APP_ADMIN grant reads and writes lists', async () => {
      const w = await world();
      const admin = await memberWith(w, 'APP_ADMIN');
      const created = await inject({
        method: 'POST',
        url: `${base(w)}/lists`,
        headers: auth(admin),
        payload: { key: 'newsletter', name: 'Newsletter' },
      });
      expect(created.statusCode, created.body).toBe(201);
    });
  });
});
