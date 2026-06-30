/**
 * GDPR / DSAR end-user data export:
 *   GET /tenant/applications/:id/end-users/:euid/export
 *
 * Covers: document shape (every section present + populated), the
 * OWNER/ADMIN role gate, cross-tenant + cross-application 404s, and —
 * critically — that no credential material (password hashes, token hashes,
 * MFA ciphertexts, license key hashes, passkey public keys) ever appears in
 * the serialized output.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

interface Bootstrapped {
  applicationId: string;
  tenantId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('end-user data export (GDPR/DSAR)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-dsar-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS dsar ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: `App dsar ${slug}`, slug: `dsar-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    return {
      applicationId: application.id,
      tenantId: session.activeTenantId,
      liveKey: key.rawKey,
      tenantAccess: session.accessToken,
    };
  }

  it('exports a complete JSON document with every data category, as an attachment', async () => {
    const b = await bootstrap('shape');

    // Sign up through the public API so a real passwordHash + refresh token exist.
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'subject@example.com', password: 'pw-one-two-three' },
    });
    expect(signUp.statusCode).toBe(201);
    const euid = (signUp.json().data as { endUser: { id: string } }).endUser.id;

    // Seed one row of everything else directly (writers covered elsewhere).
    await prisma.oAuthIdentity.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        provider: 'google',
        providerAccountId: `dsar-google-${euid}`,
        email: 'subject@gmail.example.com',
      },
    });
    await prisma.mfaCredential.create({
      data: {
        endUserId: euid,
        secretCiphertext: 'dsar-secret-ciphertext-sentinel',
        backupCodesCiphertext: 'dsar-backup-ciphertext-sentinel',
        enrolledAt: new Date(),
      },
    });
    await prisma.webAuthnCredential.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        credentialId: `dsar-cred-${euid}`,
        publicKey: 'dsar-public-key-sentinel',
        deviceName: 'Test device',
      },
    });
    const org = await prisma.organization.create({
      data: { applicationId: b.applicationId, name: 'Subject Org', slug: 'subject-org' },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, endUserId: euid, role: 'OWNER' },
    });
    const plan = await prisma.plan.create({
      data: { applicationId: b.applicationId, slug: 'dsar-pro', name: 'Pro', amount: 999 },
    });
    const sub = await prisma.subscription.create({
      data: { applicationId: b.applicationId, endUserId: euid, planId: plan.id, status: 'ACTIVE' },
    });
    await prisma.payment.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        subscriptionId: sub.id,
        amount: 999,
        currency: 'USD',
        status: 'SUCCEEDED',
        providerPaymentId: 'dsar-pay-1',
      },
    });
    await prisma.license.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        kind: 'PERPETUAL',
        keyPrefix: 'rl_lic_dsar',
        keyHash: `dsar-key-hash-sentinel-${euid}`,
      },
    });
    await prisma.creditBalance.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        subjectKey: `u:${euid}`,
        balance: 75,
      },
    });
    await prisma.creditLedger.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        subjectKey: `u:${euid}`,
        delta: 75,
        reason: 'GRANT',
        balanceAfter: 75,
        description: 'dsar grant',
      },
    });
    const meter = await prisma.usageMeter.create({
      data: { applicationId: b.applicationId, slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
    await prisma.usageRecord.create({
      data: { meterId: meter.id, endUserId: euid, quantity: 42 },
    });
    await prisma.securityEvent.create({
      data: {
        tenantId: b.tenantId,
        applicationId: b.applicationId,
        actorType: 'end_user',
        actorId: euid,
        type: 'user.signed_in',
        ip: '203.0.113.9',
      },
    });
    await prisma.impersonationAudit.create({
      data: {
        applicationId: b.applicationId,
        tenantId: b.tenantId,
        operatorUserId: 'op-dsar-test',
        endUserId: euid,
        reason: 'dsar test',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}/export`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="end-user-${euid}-export.json"`,
    );

    const doc = JSON.parse(res.body) as {
      exportVersion: number;
      exportedAt: string;
      applicationId: string;
      notes: string[];
      endUser: Record<string, unknown>;
      oauthIdentities: Array<Record<string, unknown>>;
      sessions: Array<Record<string, unknown>>;
      mfa: { enrolled: boolean } | null;
      passkeys: Array<Record<string, unknown>>;
      organizationMemberships: Array<Record<string, unknown>>;
      subscriptions: Array<Record<string, unknown>>;
      payments: Array<Record<string, unknown>>;
      licenses: Array<Record<string, unknown>>;
      creditBalance: number;
      creditLedger: Array<Record<string, unknown>>;
      usageRecords: Array<Record<string, unknown>>;
      securityEvents: Array<Record<string, unknown>>;
      impersonations: Array<Record<string, unknown>>;
    };

    expect(doc.exportVersion).toBe(1);
    expect(doc.applicationId).toBe(b.applicationId);
    expect(doc.notes.length).toBeGreaterThan(0);
    expect(doc.endUser).toMatchObject({ id: euid, email: 'subject@example.com' });
    expect(doc.oauthIdentities).toHaveLength(1);
    expect(doc.oauthIdentities[0]).toMatchObject({ provider: 'google' });
    // The public sign-up issued a refresh token → at least one session row.
    expect(doc.sessions.length).toBeGreaterThanOrEqual(1);
    expect(doc.mfa).toMatchObject({ enrolled: true });
    expect(doc.passkeys).toHaveLength(1);
    expect(doc.passkeys[0]).toMatchObject({ deviceName: 'Test device' });
    expect(doc.organizationMemberships).toHaveLength(1);
    expect(doc.organizationMemberships[0]).toMatchObject({
      organizationSlug: 'subject-org',
      role: 'OWNER',
    });
    expect(doc.subscriptions).toHaveLength(1);
    expect(doc.payments).toHaveLength(1);
    expect(doc.payments[0]).toMatchObject({ providerPaymentId: 'dsar-pay-1', amount: 999 });
    expect(doc.licenses).toHaveLength(1);
    expect(doc.licenses[0]).toMatchObject({ keyPrefix: 'rl_lic_dsar' });
    expect(doc.creditBalance).toBe(75);
    expect(doc.creditLedger).toHaveLength(1);
    expect(doc.usageRecords).toHaveLength(1);
    expect(doc.usageRecords[0]).toMatchObject({ meterSlug: 'api_calls', quantity: 42 });
    // Sign-up itself recorded a user.signed_up event alongside the seeded one.
    expect(doc.securityEvents.map((e) => e['type'])).toContain('user.signed_in');
    expect(doc.impersonations).toHaveLength(1);

    // SECURITY: the raw serialized body must contain neither credential field
    // names nor the seeded secret sentinels.
    for (const forbidden of [
      'passwordHash',
      'password_hash',
      'tokenHash',
      'token_hash',
      'keyHash',
      'key_hash',
      'secretCiphertext',
      'backupCodesCiphertext',
      'publicKey',
      'dsar-secret-ciphertext-sentinel',
      'dsar-backup-ciphertext-sentinel',
      'dsar-public-key-sentinel',
      'dsar-key-hash-sentinel',
    ]) {
      expect(res.body).not.toContain(forbidden);
    }
    // Belt-and-braces: the stored argon2 hash itself never leaks.
    const stored = await prisma.endUser.findUniqueOrThrow({
      where: { id: euid },
      select: { passwordHash: true },
    });
    expect(stored.passwordHash).toBeTruthy();
    expect(res.body).not.toContain(stored.passwordHash!);
  });

  it('MEMBER operators get 403 TENANT_ROLE_INSUFFICIENT', async () => {
    const b = await bootstrap('rolegate');
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'gated@example.com', password: 'pw-one-two-three' },
    });
    const euid = (signUp.json().data as { endUser: { id: string } }).endUser.id;

    // Invite a second operator as MEMBER; accepting returns a session scoped
    // to the owner's workspace.
    const member = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'member-dsar@example.com',
          password: 'pw-one-two-three',
          workspaceName: 'Member dsar Co',
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { email: 'member-dsar@example.com', role: 'MEMBER' },
    });
    expect(invite.statusCode).toBe(201);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { token: (invite.json().data as { token: string }).token },
    });
    expect(accept.statusCode).toBe(200);
    const memberAccess = (accept.json().data as { accessToken: string }).accessToken;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}/export`,
      headers: { authorization: `Bearer ${memberAccess}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  it('cross-tenant and cross-application requests 404 without leaking existence', async () => {
    const b = await bootstrap('xt1');
    const other = await bootstrap('xt2');
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'xt-subject@example.com', password: 'pw-one-two-three' },
    });
    const euid = (signUp.json().data as { endUser: { id: string } }).endUser.id;

    // Operator from another workspace → APPLICATION_NOT_FOUND (no enumeration).
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}/export`,
      headers: { authorization: `Bearer ${other.tenantAccess}` },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error.code).toBe('APPLICATION_NOT_FOUND');

    // Same operator, but the end-user belongs to a different application.
    const crossApp = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${other.applicationId}/end-users/${euid}/export`,
      headers: { authorization: `Bearer ${other.tenantAccess}` },
    });
    expect(crossApp.statusCode).toBe(404);
    expect(crossApp.json().error.code).toBe('END_USER_NOT_FOUND');
  });
});
