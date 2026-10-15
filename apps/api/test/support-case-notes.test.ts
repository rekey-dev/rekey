/**
 * Operator notes on a support case:
 *   POST /tenant/applications/:id/end-users/:euid/support/notes
 * and where a note is, and is not, readable afterwards.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { waitForDeliveries } from './device-fixtures.js';
import { bearer, operatorWorld } from './operator-world.js';
import { codeOf, PASSWORD, REASON, supportWorld, type Json, type SupportWorld } from './support-fixtures.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

/** Distinctive on purpose: the leak test searches serialised rows for it. */
const NOTE = 'heron-basalt-note-5519 sent build 4.2.1, customer to retry export';

describe('support case notes', () => {
  let app: FastifyInstance;
  let w: SupportWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    w = await supportWorld(app, 'sn');
    expect((await w.capability('diagnostics.debug')).statusCode).toBe(201);
  });

  const addNote = (euid: string, body: unknown = NOTE, headers: Record<string, string> = w.op()): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url: `${w.base(euid)}/support/notes`, headers, payload: { body } });

  it('adds a note to the open case and reads it back with its author, oldest first', async () => {
    const euid = await w.makeUser('note@example.com');
    const opened = (await w.open(euid)).json().data as Json;

    const first = await addNote(euid, `  ${NOTE}\u0007  `);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data).toEqual({
      id: expect.any(String),
      body: NOTE,
      authorId: w.operatorId,
      authorEmail: expect.stringContaining('op-sn-'),
      createdAt: expect.any(String),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect((await addNote(euid, 'second note')).statusCode).toBe(201);
    expect((await addNote(euid, 'x'.repeat(2000))).statusCode).toBe(201);

    const { open } = await w.read(euid);
    expect(open).toMatchObject({ id: opened.id, updatedAt: opened.updatedAt });
    expect((open!.notes as Json[]).map((n) => [n.body, n.authorId])).toEqual([
      [NOTE, w.operatorId],
      ['second note', w.operatorId],
      ['x'.repeat(2000), w.operatorId],
    ]);
    expect(open!.noteCount).toBe(3);

    const listed = await app.inject({ method: 'GET', url: `${w.appBase}/support-cases`, headers: w.op() });
    const [item] = (listed.json().data as { items: Json[] }).items;
    expect(item).toMatchObject({ id: opened.id, noteCount: 3 });
    expect(item).not.toHaveProperty('notes');
    expect(listed.body).not.toContain('heron-basalt');
  });

  it('refuses a note with no open case, a blank one and one of 2001 characters', async () => {
    const euid = await w.makeUser('refuse@example.com');
    const none = await addNote(euid);
    expect([none.statusCode, codeOf(none)]).toEqual([404, 'SUPPORT_CASE_NOT_OPEN']);

    expect((await w.open(euid)).statusCode).toBe(201);
    for (const body of ['', '   ', 'x'.repeat(2001)]) {
      const res = await addNote(euid, body);
      expect([res.statusCode, codeOf(res)], String(body.length)).toEqual([400, 'SUPPORT_NOTE_INVALID']);
    }
    const crlf = await addNote(euid, `${'x'.repeat(1998)}\r\n.`);
    expect(crlf.statusCode).toBe(201);
    expect((crlf.json().data as Json).body).toBe(`${'x'.repeat(1998)}\n.`);
    const missing = await app.inject({ method: 'POST', url: `${w.base(euid)}/support/notes`, headers: w.op(), payload: {} });
    expect([missing.statusCode, codeOf(missing)]).toEqual([400, 'BAD_REQUEST']);
    const extra = await app.inject({
      method: 'POST',
      url: `${w.base(euid)}/support/notes`,
      headers: w.op(),
      payload: { body: 'ok', caseId: 'other' },
    });
    expect([extra.statusCode, codeOf(extra)]).toEqual([400, 'VALIDATION_ERROR']);

    expect((await w.end(euid)).statusCode).toBe(200);
    const closed = await addNote(euid);
    expect([closed.statusCode, codeOf(closed)]).toEqual([404, 'SUPPORT_CASE_NOT_OPEN']);
    const stranger = await addNote('no-such-user');
    expect([stranger.statusCode, codeOf(stranger)]).toEqual([404, 'END_USER_NOT_FOUND']);
    expect(await prisma.supportCaseNote.count()).toBe(1);
  });

  it('a user token, a publishable key, a secret key and a viewer cannot add a note', async () => {
    const euid = await w.makeUser('door@example.com');
    const s = await w.signIn('door@example.com');
    expect((await w.open(euid)).statusCode).toBe(201);
    const credentials: Array<Record<string, string>> = [
      w.pk(),
      w.sk(),
      { authorization: `Bearer ${s.accessToken}` },
      { ...w.pk(), 'x-rekey-user-token': s.accessToken },
      {},
    ];
    for (const headers of credentials) {
      expect([401, 403], JSON.stringify(Object.keys(headers))).toContain((await addNote(euid, NOTE, headers)).statusCode);
    }

    const world = await operatorWorld(app, 'APP_VIEWER');
    const appBase = `/api/v1/tenant/applications/${world.appId}`;
    const created = await world.inject({
      method: 'POST',
      url: `${appBase}/end-users`,
      headers: bearer(world.ownerToken),
      payload: { email: 'viewer@example.com', password: PASSWORD },
    });
    const viewed = (created.json().data as { id: string }).id;
    await world.inject({ method: 'POST', url: `${appBase}/support-capabilities`, headers: bearer(world.ownerToken), payload: { name: 'diagnostics.debug' } });
    const notesUrl = `${appBase}/end-users/${viewed}/support/notes`;
    const openedThere = await world.inject({
      method: 'POST',
      url: `${appBase}/end-users/${viewed}/support`,
      headers: bearer(world.ownerToken),
      payload: { capabilities: ['diagnostics.debug'], reason: REASON },
    });
    expect(openedThere.statusCode, openedThere.body).toBe(201);
    const asViewer = await world.inject({ method: 'POST', url: notesUrl, headers: bearer(world.memberToken), payload: { body: NOTE } });
    expect(asViewer.statusCode).toBe(403);
    const asStranger = await world.inject({ method: 'POST', url: notesUrl, headers: bearer(w.operator), payload: { body: NOTE } });
    expect(asStranger.statusCode).toBe(404);
    // A viewer reads the notes an owner wrote.
    expect((await world.inject({ method: 'POST', url: notesUrl, headers: bearer(world.ownerToken), payload: { body: NOTE } })).statusCode).toBe(201);
    const read = await world.inject({ method: 'GET', url: `${appBase}/end-users/${viewed}/support`, headers: bearer(world.memberToken) });
    expect(((read.json().data as { open: Json }).open.notes as Json[]).map((n) => n.body)).toEqual([NOTE]);

    expect(await prisma.supportCaseNote.count()).toBe(1);
  });

  it('a note is in no webhook, security event, export or end-user read, and a closed case keeps its notes', async () => {
    const euid = await w.makeUser('leak@example.com');
    const s = await w.signIn('leak@example.com', 'fp-note-leak-001');
    const first = (await w.open(euid)).json().data as Json;
    const eventsBefore = await prisma.securityEvent.count({ where: { applicationId: w.appId } });
    const deliveriesBefore = await prisma.webhookDelivery.count({ where: { applicationId: w.appId } });
    expect((await addNote(euid)).statusCode).toBe(201);
    // The note row is the record: adding one announces nothing.
    expect(await prisma.securityEvent.count({ where: { applicationId: w.appId } })).toBe(eventsBefore);
    expect(await prisma.webhookDelivery.count({ where: { applicationId: w.appId } })).toBe(deliveriesBefore);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me?include=support', headers: { 'x-rekey-user-token': s.accessToken } });
    expect(me.body).not.toContain('heron-basalt');
    const backend = await app.inject({ method: 'GET', url: `/api/v1/users/${euid}/support`, headers: w.sk() });
    expect(backend.statusCode).toBe(200);
    expect(backend.body).not.toContain('heron-basalt');

    expect((await w.end(euid)).statusCode).toBe(200);
    const second = (await w.open(euid)).json().data as Json;
    expect((await addNote(euid, 'on the second case')).statusCode).toBe(201);

    const state = await w.read(euid);
    expect((state.open!.notes as Json[]).map((n) => n.body)).toEqual(['on the second case']);
    expect(state.open!.id).toBe(second.id);
    expect(state.history.map((c) => [c.id, (c.notes as Json[]).map((n) => n.body)])).toEqual([[first.id, [NOTE]]]);

    const exported = await app.inject({ method: 'GET', url: `${w.base(euid)}/export`, headers: w.op() });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).not.toContain('heron-basalt');
    expect(exported.body).not.toContain('on the second case');
    await waitForDeliveries({ applicationId: w.appId, eventType: 'support.opened' }, 2);
    expect(JSON.stringify(await prisma.webhookDelivery.findMany({ where: { applicationId: w.appId } }))).not.toContain('heron-basalt');
    expect(JSON.stringify(await prisma.securityEvent.findMany({ where: { applicationId: w.appId } }))).not.toContain('heron-basalt');
  });

  it('erasing or deleting the end-user deletes their notes and keeps the cases', async () => {
    const erased = await w.makeUser('erase-notes@example.com');
    const deleted = await w.makeUser('delete-notes@example.com');
    const kept = await w.makeUser('kept-notes@example.com');
    for (const euid of [erased, deleted, kept]) {
      expect((await w.open(euid)).statusCode).toBe(201);
      expect((await addNote(euid)).statusCode).toBe(201);
      expect((await w.end(euid)).statusCode).toBe(200);
      expect((await w.open(euid)).statusCode).toBe(201);
      expect((await addNote(euid)).statusCode).toBe(201);
    }
    expect((await app.inject({ method: 'DELETE', url: `${w.base(erased)}?erasure=true`, headers: w.op() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: w.base(deleted), headers: w.op() })).statusCode).toBe(200);

    const notes = await prisma.supportCaseNote.findMany({ where: { applicationId: w.appId } });
    expect(notes.map((n) => n.endUserId)).toEqual([kept, kept]);
    for (const euid of [erased, deleted]) {
      expect(await prisma.supportCase.count({ where: { endUserId: euid, status: 'CLOSED' } })).toBe(2);
    }
    expect((await w.read(erased)).history.map((c) => c.notes)).toEqual([[], []]);
  });
});
