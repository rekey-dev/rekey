/**
 * A customer sees which machines hold seats on their licence and frees one
 * from their account, without the licence key. A licence pooled to an
 * organization is visible to its members and freed by its owners and admins.
 * Nobody else can see or touch another account's machines.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { as, endUser, member, orgApp, type OrgApp } from './organization-fixtures.js';

operatorsConfirmTheirEmail();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const FINGERPRINT_A = 'machine-alpha-0123456789abcdef';
const FINGERPRINT_B = 'machine-bravo-0123456789abcdef';

async function seatsLicense(o: OrgApp, holderId: string, seats = 2): Promise<{ id: string; rawKey: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenant/applications/${o.applicationId}/licenses`,
    headers: { authorization: `Bearer ${o.operatorToken}` },
    payload: { endUserId: holderId, kind: 'SEATS', seatsAllowed: seats },
  });
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data as { license: { id: string }; rawKey: string };
  return { id: data.license.id, rawKey: data.rawKey };
}

async function verifyOn(o: OrgApp, rawKey: string, machineFingerprint: string, label?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/licenses/verify',
    headers: { authorization: `Bearer ${o.key}` },
    payload: { key: rawKey, machineFingerprint, ...(label && { label }) },
  });
  return res.json().data as { ok: boolean; reason?: string };
}

const listUrl = (licenseId: string) => `/api/v1/users/me/licenses/${licenseId}/activations`;

async function activations(o: OrgApp, user: { access: string }, licenseId: string) {
  return app.inject({ method: 'GET', url: listUrl(licenseId), headers: as(o, user) });
}

function remove(o: OrgApp, user: { access: string }, licenseId: string, activationId: string) {
  return app.inject({ method: 'DELETE', url: `${listUrl(licenseId)}/${activationId}`, headers: as(o, user) });
}

describe("a customer's licence machines", () => {
  it('lists the machines with a shortened fingerprint, never the whole one', async () => {
    const o = await orgApp(app, 'act-list', { billing: true });
    const lic = await seatsLicense(o, o.owner.id);
    await verifyOn(o, lic.rawKey, FINGERPRINT_A, 'Work laptop');
    await verifyOn(o, lic.rawKey, FINGERPRINT_B);

    const res = await activations(o, o.owner, lic.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(FINGERPRINT_A);
    expect(res.body).not.toContain(FINGERPRINT_B);
    const { items, page } = res.json().data as { items: Array<Record<string, unknown>>; page: { total: number } };
    expect(page.total).toBe(2);
    expect(Object.keys(items[0]!).sort()).toEqual(
      ['fingerprintHint', 'firstSeenAt', 'id', 'label', 'lastSeenAt', 'status'].sort(),
    );
    const laptop = items.find((i) => i.label === 'Work laptop')!;
    expect(laptop).toMatchObject({ status: 'ACTIVE', fingerprintHint: 'machin…' });
  });

  it('frees a seat by activation id, so another machine can verify, and is idempotent', async () => {
    const o = await orgApp(app, 'act-free', { billing: true });
    const lic = await seatsLicense(o, o.owner.id, 1);
    await verifyOn(o, lic.rawKey, FINGERPRINT_A);
    expect(await verifyOn(o, lic.rawKey, FINGERPRINT_B)).toMatchObject({ ok: false, reason: 'seats_exhausted' });

    const id = ((await activations(o, o.owner, lic.id)).json().data.items as Array<{ id: string }>)[0]!.id;
    const first = await remove(o, o.owner, lic.id, id);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toEqual({ ok: true, released: true });
    expect(await verifyOn(o, lic.rawKey, FINGERPRINT_B)).toMatchObject({ ok: true });
    expect((await remove(o, o.owner, lic.id, id)).json().data).toEqual({ ok: true, released: false });

    const after = (await activations(o, o.owner, lic.id)).json().data.items as Array<{ id: string; status: string }>;
    expect(after.map((a) => a.status)).toEqual(['ACTIVE', 'RELEASED']);
    expect(after[1]!.id).toBe(id);
  });

  it('applies the same policy as the key-based deactivate: a revoked licence frees nothing', async () => {
    const o = await orgApp(app, 'act-revoked', { billing: true });
    const lic = await seatsLicense(o, o.owner.id);
    await verifyOn(o, lic.rawKey, FINGERPRINT_A);
    const id = ((await activations(o, o.owner, lic.id)).json().data.items as Array<{ id: string }>)[0]!.id;
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${o.applicationId}/licenses/${lic.id}`,
      headers: { authorization: `Bearer ${o.operatorToken}` },
    });
    expect((await remove(o, o.owner, lic.id, id)).json().data).toEqual({ ok: false, reason: 'revoked' });
  });

  it("refuses another account's licence, and an activation from another licence, as not found", async () => {
    const o = await orgApp(app, 'act-cross', { billing: true });
    const stranger = await endUser(app, o, 'stranger@example.com');
    const lic = await seatsLicense(o, o.owner.id);
    const theirs = await seatsLicense(o, stranger.id);
    await verifyOn(o, lic.rawKey, FINGERPRINT_A);
    await verifyOn(o, theirs.rawKey, FINGERPRINT_B);
    const mine = ((await activations(o, o.owner, lic.id)).json().data.items as Array<{ id: string }>)[0]!.id;
    const theirActivation = ((await activations(o, stranger, theirs.id)).json().data.items as Array<{ id: string }>)[0]!.id;

    const peek = await activations(o, stranger, lic.id);
    expect(peek.statusCode).toBe(404);
    expect(peek.json().error.code).toBe('LICENSE_NOT_FOUND');
    expect((await remove(o, stranger, lic.id, mine)).json().error.code).toBe('LICENSE_NOT_FOUND');
    const crossed = await remove(o, o.owner, lic.id, theirActivation);
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json().error.code).toBe('LICENSE_ACTIVATION_NOT_FOUND');
  });

  it("refuses a licence from another Application as not found", async () => {
    const o = await orgApp(app, 'act-app-a', { billing: true });
    const other = await orgApp(app, 'act-app-b', { billing: true });
    const lic = await seatsLicense(o, o.owner.id);
    const res = await activations(other, other.owner, lic.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('LICENSE_NOT_FOUND');
  });
});

describe("an organization's pooled licence", () => {
  it('members may see its machines; only an owner or admin may free a seat; outsiders see nothing', async () => {
    const o = await orgApp(app, 'act-org', { billing: true });
    const plain = await member(app, o, 'plain@example.com');
    const admin = await member(app, o, 'admin@example.com', 'ADMIN');
    const outsider = await endUser(app, o, 'outsider@example.com');
    const lic = await seatsLicense(o, o.owner.id);
    await prisma.license.update({ where: { id: lic.id }, data: { organizationId: o.organizationId } });
    await verifyOn(o, lic.rawKey, FINGERPRINT_A);

    const seen = await activations(o, plain, lic.id);
    expect(seen.statusCode).toBe(200);
    const id = (seen.json().data.items as Array<{ id: string }>)[0]!.id;
    expect((await activations(o, outsider, lic.id)).statusCode).toBe(404);

    const byMember = await remove(o, plain, lic.id, id);
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json().error.code).toBe('ORGANIZATION_ROLE_INSUFFICIENT');
    expect((await remove(o, outsider, lic.id, id)).statusCode).toBe(404);
    expect((await remove(o, admin, lic.id, id)).json().data).toEqual({ ok: true, released: true });
  });
});
