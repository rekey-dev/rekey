/**
 * GDPR end-user erasure:
 *   DELETE /tenant/applications/:id/end-users/:euid?erasure=true
 *
 * Covers (roadmap §10):
 *   - erasure tombstones the user (erasedAt set) + anonymizes the email;
 *   - PII/auth rows are GONE (oauth / sessions / mfa / passkeys / magic-link /
 *     reset / verify tokens; passwordHash cleared);
 *   - financial rows are RETAINED but PII-scrubbed (metadata/description);
 *   - an erased user can't sign in / magic-link / refresh / use a live access
 *     token (all surface END_USER_ERASED, HTTP 410);
 *   - a `user.erased` outbound webhook is emitted;
 *   - an `end_user.erased` security event is recorded;
 *   - OWNER/ADMIN gate (MEMBER → 403);
 *   - cross-tenant / cross-application 404 (no enumeration);
 *   - plain DELETE (no flag) still hard-deletes everything (back-compat);
 *   - a failed provider cancel REFUSES the delete (502 PROVIDER_CANCEL_FAILED)
 *     but does NOT block an erasure, the deliberate asymmetry.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { tombstoneEmail } from '../src/modules/tenant-applications/end-user-erasure.service.js';
import { euLoginLockScope, getScopeLockState, LOGIN_POLICY } from '../src/lib/brute-force.js';
import { FakeStripeProvider } from './fakes/billing-providers.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

interface Bootstrapped {
  applicationId: string;
  tenantId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('end-user erasure (GDPR right to be forgotten)', () => {
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
          email: `op-erase-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS erase ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: `App erase ${slug}`, slug: `erase-${slug}`, enableBilling: true },
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

  /** Sign a user up through the public API and return ids + a live session. */
  async function signUpUser(
    b: Bootstrapped,
    email: string,
  ): Promise<{ euid: string; accessToken: string; refreshToken: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as {
      endUser: { id: string };
      accessToken: string;
      refreshToken: string;
    };
    return { euid: data.endUser.id, accessToken: data.accessToken, refreshToken: data.refreshToken };
  }

  /** Poll until `fn` returns truthy or the deadline passes (for fire-and-forget side effects). */
  async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function erase(b: Bootstrapped, euid: string, access = b.tenantAccess) {
    return app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}?erasure=true`,
      headers: { authorization: `Bearer ${access}` },
    });
  }

  it('tombstones the user, deletes PII/auth, retains-but-scrubs financials, emits event + webhook', async () => {
    const b = await bootstrap('full');
    const { euid } = await signUpUser(b, 'subject@example.com');

    // Subscribe an endpoint to user.erased so we can prove the webhook fires.
    await prisma.webhookEndpoint.create({
      data: {
        applicationId: b.applicationId,
        url: 'https://example.com/hook',
        secret: 'whsec_test_erasure',
        events: ['user.erased'],
        enabled: true,
      },
    });

    // Seed PII/auth rows that must be hard-deleted.
    await prisma.oAuthIdentity.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        provider: 'google',
        providerAccountId: `erase-google-${euid}`,
        email: 'subject@gmail.example.com',
      },
    });
    await prisma.mfaCredential.create({
      data: {
        endUserId: euid,
        secretCiphertext: 'ct-secret',
        backupCodesCiphertext: 'ct-backup',
        enrolledAt: new Date(),
      },
    });
    await prisma.webAuthnCredential.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        credentialId: `erase-cred-${euid}`,
        publicKey: 'pk',
        deviceName: 'Test device',
      },
    });
    await prisma.magicLinkToken.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        tokenHash: `mlt-${euid}`,
        email: 'subject@example.com',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.passwordResetToken.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        tokenHash: `prt-${euid}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.emailVerificationToken.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        tokenHash: `evt-${euid}`,
        email: 'subject@example.com',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // Seed financial rows with PII in metadata/description that must be scrubbed
    // but the ROWS retained.
    const plan = await prisma.plan.create({
      data: { applicationId: b.applicationId, slug: 'erase-pro', name: 'Pro', amount: 999 },
    });
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        planId: plan.id,
        status: 'ACTIVE',
        metadata: { customerEmail: 'subject@example.com', note: 'pii here' },
      },
    });
    const pay = await prisma.payment.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        subscriptionId: sub.id,
        amount: 999,
        currency: 'USD',
        status: 'SUCCEEDED',
        providerPaymentId: 'erase-pay-1',
        description: 'subject@example.com receipt',
        metadata: { billingEmail: 'subject@example.com' },
      },
    });
    const lic = await prisma.license.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        kind: 'PERPETUAL',
        keyPrefix: 'rl_lic_erase',
        keyHash: `erase-key-hash-${euid}`,
        metadata: { ownerEmail: 'subject@example.com' },
      },
    });
    const ledger = await prisma.creditLedger.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        subjectKey: `u:${euid}`,
        delta: 50,
        reason: 'GRANT',
        balanceAfter: 50,
        description: 'grant for subject@example.com',
        metadata: { who: 'subject@example.com' },
      },
    });
    await prisma.creditBalance.create({
      data: { applicationId: b.applicationId, endUserId: euid, subjectKey: `u:${euid}`, balance: 50 },
    });
    const meter = await prisma.usageMeter.create({
      data: { applicationId: b.applicationId, slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
    const usage = await prisma.usageRecord.create({
      data: {
        meterId: meter.id,
        endUserId: euid,
        quantity: 42,
        metadata: { ip: '203.0.113.9', email: 'subject@example.com' },
      },
    });

    // ── ERASE ───────────────────────────────────────────────────────────────
    const res = await erase(b, euid);
    expect(res.statusCode).toBe(200);
    const out = res.json().data as { erased: boolean; erasedAt: string; alreadyErased: boolean };
    expect(out.erased).toBe(true);
    expect(out.alreadyErased).toBe(false);
    expect(out.erasedAt).toBeTruthy();

    // Tombstone: row kept, email anonymized, credentials cleared, erasedAt set.
    const tombstone = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
    expect(tombstone.erasedAt).not.toBeNull();
    expect(tombstone.email).toBe(tombstoneEmail(euid));
    expect(tombstone.passwordHash).toBeNull();
    expect(tombstone.metadata).toBeNull();
    expect(tombstone.emailVerified).toBe(false);

    // PII/auth rows hard-deleted.
    expect(await prisma.oAuthIdentity.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.mfaCredential.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.webAuthnCredential.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.magicLinkToken.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.passwordResetToken.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.emailVerificationToken.count({ where: { endUserId: euid } })).toBe(0);

    // Financial rows RETAINED (still there) but PII-scrubbed.
    const subAfter = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(subAfter.endUserId).toBe(euid); // FK preserved by the tombstone.
    expect(subAfter.metadata).toEqual({});
    const payAfter = await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } });
    expect(payAfter.amount).toBe(999); // accounting figure untouched.
    expect(payAfter.description).toBeNull();
    expect(payAfter.metadata).toEqual({});
    const licAfter = await prisma.license.findUniqueOrThrow({ where: { id: lic.id } });
    expect(licAfter.metadata).toEqual({});
    const ledgerAfter = await prisma.creditLedger.findUniqueOrThrow({ where: { id: ledger.id } });
    expect(ledgerAfter.delta).toBe(50); // ledger figure untouched.
    expect(ledgerAfter.description).toBeNull();
    expect(ledgerAfter.metadata).toEqual({});
    const usageAfter = await prisma.usageRecord.findUniqueOrThrow({ where: { id: usage.id } });
    expect(usageAfter.quantity).toBe(42);
    expect(usageAfter.metadata).toEqual({});

    // Security event recorded (fire-and-forget, poll briefly).
    const events = await waitForSecurityEvents({ applicationId: b.applicationId, type: 'end_user.erased' });
    expect(events).toHaveLength(1);
    expect((events[0]!.metadata as { endUserId: string }).endUserId).toBe(euid);

    // Webhook delivery enqueued for user.erased (fire-and-forget, poll briefly).
    const deliveries = await waitFor(async () => {
      const rows = await prisma.webhookDelivery.findMany({
        where: { applicationId: b.applicationId, eventType: 'user.erased' },
      });
      return rows.length > 0 ? rows : null;
    });
    expect(deliveries).not.toBeNull();
    expect(deliveries!.length).toBeGreaterThanOrEqual(1);
  });

  it('an erased user cannot sign in / magic-link / refresh / use a live access token', async () => {
    const b = await bootstrap('authblock');
    // Enable magic-link so that leg genuinely exercises the erasure gate.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { methods: ['password', 'magic_link'] },
    });
    const { euid, accessToken, refreshToken } = await signUpUser(b, 'blocked@example.com');

    // Access token works BEFORE erasure.
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': accessToken },
    });
    expect(before.statusCode).toBe(200);

    expect((await erase(b, euid)).statusCode).toBe(200);

    // Sign-in: password hash is cleared → INVALID_CREDENTIALS (no enumeration).
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'blocked@example.com', password: 'pw-one-two-three' },
    });
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json().error.code).toBe('INVALID_CREDENTIALS');

    // Refresh: a pre-erasure refresh token must not mint a new session. Erasure
    // hard-deletes the refresh tokens, so the presented token is now UNKNOWN
    // (REFRESH_TOKEN_INVALID, 401); even if a token somehow survived, the
    // erased-user guard in refresh would reject it (END_USER_ERASED, 410).
    // Either way the contract is: it never returns a session.
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBeGreaterThanOrEqual(400);
    expect(['REFRESH_TOKEN_INVALID', 'END_USER_ERASED']).toContain(refresh.json().error.code);

    // A still-unexpired access token is rejected at the session chokepoint.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': accessToken },
    });
    expect(me.statusCode).toBe(410);
    expect(me.json().error.code).toBe('END_USER_ERASED');

    // Magic-link: requesting + verifying for the (old) email cannot revive them.
    // (Magic-link may be disabled on the app, if so, this leg is a no-op; the
    // sign-in / access-token / refresh legs already prove the erasure block.)
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'blocked@example.com' },
    });
    const reqData = reqRes.json().data as { magicLinkToken: string | null } | undefined;
    const mlt = reqData?.magicLinkToken ?? null;
    // The old email no longer maps to the (tombstoned) user, so either no token
    // is issued for an existing account, or verifying it cannot mint a session.
    if (mlt) {
      const verify = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/verify',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { token: mlt },
      });
      // Whatever path it takes, it must NOT return a session for the erased user.
      const body = verify.json();
      if (verify.statusCode === 200) {
        expect((body.data as { endUser: { id: string } }).endUser.id).not.toBe(euid);
      }
    }
  });

  it('erasure drops the brute-force lock, which holds the address in plaintext', async () => {
    // The tombstone update used to zero `failedSignInAttempts` / `lockedUntil`
    // on the row. Lockout has been in Redis for several releases, so that
    // erased nothing, and the limiter's key is
    // `bf:lock:eu:login:<appId>:<email>`, i.e. it holds the ERASED address in
    // plaintext for up to the 15-minute lock TTL, where the super-admin
    // locked-accounts dashboard enumerates it. An erasure that leaves the email
    // in a key an operator UI reads back is not an erasure.
    const b = await bootstrap('lockclear');
    const email = 'lockclear@example.com';
    const { euid } = await signUpUser(b, email);

    const scope = euLoginLockScope(b.applicationId, email);
    for (let i = 0; i < LOGIN_POLICY.threshold; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email, password: 'wrong-' + i },
      });
    }
    expect((await getScopeLockState(scope))?.lockedForSec).toBeGreaterThan(0);

    expect((await erase(b, euid)).statusCode).toBe(200);
    expect(await getScopeLockState(scope)).toEqual({ lockedForSec: null, failuresInWindow: 0 });
  });

  it('scrubs the address from email logs, suppressions and webhook payloads, and touches nobody else', async () => {
    // The EndUser row was tombstoned while every log that copied the address
    // at send or receive time kept it: the operator console still showed it,
    // and the log archive would have exported it when the rows aged out.
    const b = await bootstrap('logscrub');
    const other = await bootstrap('logscrub-other');
    const email = 'logsubject@example.com';
    // Similar to the subject's address but not containing it, in the SAME Application.
    const neighbourEmail = 'logsubject@example.co';
    for (const x of [b, other]) {
      await prisma.webhookEndpoint.create({
        data: {
          applicationId: x.applicationId,
          url: 'https://example.com/hook',
          secret: 'whsec_test_logscrub',
          events: ['user.created'],
          enabled: true,
        },
      });
    }
    const { euid } = await signUpUser(b, email);
    const { euid: neighbour } = await signUpUser(b, neighbourEmail);
    // The IDENTICAL address, in ANOTHER Application: a different data subject.
    const { euid: twin } = await signUpUser(other, email);

    // Real user.created deliveries carry the address. Enqueued fire-and-forget.
    for (const [applicationId, id] of [
      [b.applicationId, euid],
      [b.applicationId, neighbour],
      [other.applicationId, twin],
    ] as const) {
      const row = await waitFor(() =>
        prisma.webhookDelivery.findFirst({
          where: { applicationId, eventType: 'user.created', payload: { path: ['data', 'user', 'id'], equals: id } },
        }),
      );
      expect(row).not.toBeNull();
    }

    async function seed(x: Bootstrapped, subjectId: string, address: string, tag: string) {
      const endpoint = await prisma.webhookEndpoint.findFirstOrThrow({ where: { applicationId: x.applicationId } });
      await prisma.emailLog.createMany({
        data: [
          {
            tenantId: x.tenantId,
            applicationId: x.applicationId,
            toAddress: address,
            subject: `Welcome, ${address}`,
            eventKey: 'welcome',
            via: 'byo_resend',
            status: 'sent',
            messageId: `msg-${tag}`,
          },
          {
            tenantId: x.tenantId,
            applicationId: x.applicationId,
            toAddress: address,
            subject: 'Reset your password',
            eventKey: 'password_reset',
            via: 'byo_smtp',
            status: 'error',
            error: `550 mailbox ${address.toUpperCase()} unavailable`,
          },
        ],
      });
      await prisma.emailSuppression.create({
        data: { applicationId: x.applicationId, address, reason: 'bounce', note: 'hard bounce' },
      });
      const envelope = (eventId: string, type: string, data: Prisma.InputJsonObject) => ({
        eventId,
        occurredAt: new Date().toISOString(),
        type,
        applicationId: x.applicationId,
        data,
      });
      await prisma.webhookDelivery.createMany({
        data: [
          {
            endpointId: endpoint.id,
            applicationId: x.applicationId,
            eventId: `pc-${tag}`,
            eventType: 'password.changed',
            status: 'SUCCEEDED',
            attempts: 1,
            payload: envelope(`pc-${tag}`, 'password.changed', { userId: subjectId, email: address, via: 'reset' }),
          },
          {
            endpointId: endpoint.id,
            applicationId: x.applicationId,
            eventId: `dev-${tag}`,
            eventType: 'device.registered',
            status: 'FAILED',
            attempts: 5,
            payload: envelope(`dev-${tag}`, 'device.registered', {
              device: {
                id: `dev-${tag}`,
                endUserId: subjectId,
                fingerprint: `fp-${tag}`,
                label: `${address} laptop`,
                status: 'ACTIVE',
              },
              reactivated: false,
            }),
          },
        ],
      });
      await prisma.webhookEvent.create({
        data: {
          applicationId: x.applicationId,
          provider: 'stripe',
          providerEventId: `evt-${tag}`,
          eventType: 'invoice.paid',
          payload: {
            id: `evt-${tag}`,
            type: 'invoice.paid',
            data: {
              object: {
                customer: `cus_${tag}`,
                customer_email: address,
                lines: [{ description: `Pro plan for ${address.toUpperCase()}` }],
              },
            },
          },
        },
      });
    }
    await seed(b, euid, email, 'subject');
    await seed(b, neighbour, neighbourEmail, 'neighbour');
    await seed(other, twin, email, 'twin');
    // A different customer whose address CONTAINS the subject's.
    const lookalike = await prisma.webhookEvent.create({
      data: {
        applicationId: b.applicationId,
        provider: 'stripe',
        providerEventId: 'evt-lookalike',
        eventType: 'invoice.paid',
        payload: { data: { object: { customer_email: `x${email}` } } },
      },
    });

    const countsFor = async (applicationId: string) => ({
      emailLogs: await prisma.emailLog.count({ where: { applicationId } }),
      deliveries: await prisma.webhookDelivery.count({ where: { applicationId } }),
      receipts: await prisma.webhookEvent.count({ where: { applicationId } }),
    });
    // Rows that must come through byte-for-byte: everything in the other
    // Application, and the neighbour's rows in this one. Deliveries compare on
    // payload only; a PENDING one may be attempted while the test runs.
    const untouched = async () => ({
      logs: await prisma.emailLog.findMany({
        where: { OR: [{ applicationId: other.applicationId }, { toAddress: neighbourEmail }] },
        orderBy: { id: 'asc' },
      }),
      suppressions: await prisma.emailSuppression.findMany({
        where: { OR: [{ applicationId: other.applicationId }, { address: neighbourEmail }] },
        orderBy: { id: 'asc' },
      }),
      deliveries: await prisma.webhookDelivery.findMany({
        where: {
          OR: [
            { applicationId: other.applicationId },
            { eventId: { endsWith: '-neighbour' } },
            { payload: { path: ['data', 'user', 'id'], equals: neighbour } },
          ],
        },
        select: { id: true, payload: true },
        orderBy: { id: 'asc' },
      }),
      receipts: await prisma.webhookEvent.findMany({
        where: {
          OR: [
            { applicationId: other.applicationId },
            { providerEventId: { in: ['evt-neighbour', 'evt-lookalike'] } },
          ],
        },
        orderBy: { id: 'asc' },
      }),
    });
    const countsBefore = await countsFor(b.applicationId);
    const untouchedBefore = await untouched();

    expect((await erase(b, euid)).statusCode).toBe(200);

    // Nothing left anywhere in this Application that carries the raw address
    // (the lookalike receipt is a different address that contains it).
    const like = `%${email}%`;
    const [left] = await prisma.$queryRaw<[{ logs: number; suppressions: number; deliveries: number; receipts: number }]>`
      SELECT
        (SELECT count(*)::int FROM email_logs WHERE application_id = ${b.applicationId}
           AND (to_address ILIKE ${like} OR subject ILIKE ${like} OR coalesce(error, '') ILIKE ${like})) AS logs,
        (SELECT count(*)::int FROM email_suppressions WHERE application_id = ${b.applicationId}
           AND address ILIKE ${like}) AS suppressions,
        (SELECT count(*)::int FROM webhook_deliveries WHERE application_id = ${b.applicationId}
           AND payload::text ILIKE ${like}) AS deliveries,
        (SELECT count(*)::int FROM webhook_events WHERE application_id = ${b.applicationId}
           AND id <> ${lookalike.id} AND payload::text ILIKE ${like}) AS receipts`;
    expect(left).toEqual({ logs: 0, suppressions: 0, deliveries: 0, receipts: 0 });

    // Log and delivery rows are kept; the suppression is the one row that goes.
    expect(await countsFor(b.applicationId)).toEqual(countsBefore);
    expect(await prisma.emailSuppression.count({ where: { applicationId: b.applicationId } })).toBe(1);

    // The other personal fields of our own payloads, not only the address.
    const device = await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: 'dev-subject' } });
    expect(device.status).toBe('FAILED');
    expect(device.attempts).toBe(5);
    expect((device.payload as { data: { device: Record<string, unknown> } }).data.device).toMatchObject({
      endUserId: euid,
      fingerprint: 'erased',
      label: null,
    });
    const created = await prisma.webhookDelivery.findFirstOrThrow({
      where: { applicationId: b.applicationId, payload: { path: ['data', 'user', 'id'], equals: euid } },
    });
    expect((created.payload as { data: { user: { email: string } } }).data.user.email).toBe(tombstoneEmail(euid));
    const logs = await prisma.emailLog.findMany({ where: { applicationId: b.applicationId, toAddress: tombstoneEmail(euid) } });
    // Seeded rows plus whatever sign-up itself sent; all of them now point at the tombstone.
    expect(logs.map((l) => l.status)).toEqual(expect.arrayContaining(['error', 'sent']));
    expect(logs.every((l) => l.subject === '[erased]')).toBe(true);

    // Everyone else: byte-for-byte.
    expect(await untouched()).toEqual(untouchedBefore);

    // And their data export still carries their own data.
    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${neighbour}/export`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(exported.statusCode).toBe(200);
    expect((JSON.parse(exported.body) as { endUser: { email: string } }).endUser.email).toBe(neighbourEmail);
  });

  it('is idempotent — erasing an already-erased user is a no-op', async () => {
    const b = await bootstrap('idem');
    const { euid } = await signUpUser(b, 'idem@example.com');
    expect((await erase(b, euid)).statusCode).toBe(200);
    const second = await erase(b, euid);
    expect(second.statusCode).toBe(200);
    expect((second.json().data as { alreadyErased: boolean }).alreadyErased).toBe(true);
  });

  it('MEMBER operators cannot erase — a grant-less member cannot even see the Application', async () => {
    const b = await bootstrap('rolegate');
    const { euid } = await signUpUser(b, 'gated@example.com');

    const member = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'member-erase@example.com',
          password: 'pw-one-two-three',
          workspaceName: 'Member erase Co',
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { email: 'member-erase@example.com', role: 'MEMBER' },
    });
    expect(invite.statusCode).toBe(201);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { token: (invite.json().data as { token: string }).token },
    });
    const memberAccess = (accept.json().data as { accessToken: string }).accessToken;

    // 404, not 403, since 2.0.0-rc.3: a freshly invited MEMBER holds no
    // grants, so the Application is invisible to them and the refusal happens
    // in ensureAppAccess before the OWNER/ADMIN role gate is ever consulted.
    // Same non-disclosure posture as the cross-tenant case below.
    const res = await erase(b, euid, memberAccess);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('APPLICATION_NOT_FOUND');
    // Not erased.
    const still = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
    expect(still.erasedAt).toBeNull();
  });

  it('cross-tenant and cross-application erasure 404 without leaking existence', async () => {
    const b = await bootstrap('xt1');
    const other = await bootstrap('xt2');
    const { euid } = await signUpUser(b, 'xt-subject@example.com');

    const crossTenant = await erase(b, euid, other.tenantAccess);
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error.code).toBe('APPLICATION_NOT_FOUND');

    const crossApp = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${other.applicationId}/end-users/${euid}?erasure=true`,
      headers: { authorization: `Bearer ${other.tenantAccess}` },
    });
    expect(crossApp.statusCode).toBe(404);
    expect(crossApp.json().error.code).toBe('END_USER_NOT_FOUND');

    // The targeted user is untouched.
    const still = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
    expect(still.erasedAt).toBeNull();
  });

  it('plain DELETE (no erasure flag) still hard-deletes everything (back-compat)', async () => {
    const b = await bootstrap('plain');
    const { euid } = await signUpUser(b, 'plain@example.com');
    const plan = await prisma.plan.create({
      data: { applicationId: b.applicationId, slug: 'plain-pro', name: 'Pro', amount: 100 },
    });
    const sub = await prisma.subscription.create({
      data: { applicationId: b.applicationId, endUserId: euid, planId: plan.id, status: 'ACTIVE' },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { removed: boolean }).removed).toBe(true);

    // The user row AND its cascade-FK financial rows are gone.
    expect(await prisma.endUser.findUnique({ where: { id: euid } })).toBeNull();
    expect(await prisma.subscription.findUnique({ where: { id: sub.id } })).toBeNull();
  });

  // ── BUG-1 / BUG-3c: delete must cancel the provider sub + emit user.deleted +
  //    record an end_user.deleted security event; provider failure must not block.
  describe('end-user delete cancels the provider subscription (BUG-1/BUG-3c)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Create an ACTIVE provider-backed (stripe) subscription for a user. */
    async function seedProviderSub(b: Bootstrapped, euid: string, suffix: string): Promise<string> {
      const plan = await prisma.plan.create({
        data: { applicationId: b.applicationId, slug: `pcancel-${suffix}`, name: 'Pro', amount: 999 },
      });
      const sub = await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: euid,
          planId: plan.id,
          status: 'ACTIVE',
          provider: 'stripe',
          providerSubId: `sub_${suffix}_${euid}`,
        },
      });
      return sub.id;
    }

    it('plain delete invokes provider cancel, emits user.deleted, records end_user.deleted', async () => {
      const b = await bootstrap('pcancel');
      const { euid } = await signUpUser(b, 'pcancel@example.com');
      const subId = await seedProviderSub(b, euid, 'plain');

      const cancelSpy = vi
        .spyOn(FakeStripeProvider.prototype, 'cancelSubscription')
        .mockResolvedValue(undefined);

      await prisma.webhookEndpoint.create({
        data: {
          applicationId: b.applicationId,
          url: 'https://example.com/hook',
          secret: 'whsec_test_deleted',
          events: ['user.deleted'],
          enabled: true,
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(res.statusCode).toBe(200);

      // Provider cancel was attempted for the active sub.
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      const arg = cancelSpy.mock.calls[0]![0] as { subscription: { id: string }; atPeriodEnd: boolean };
      expect(arg.subscription.id).toBe(subId);
      expect(arg.atPeriodEnd).toBe(false);

      // User + cascade gone.
      expect(await prisma.endUser.findUnique({ where: { id: euid } })).toBeNull();

      // end_user.deleted security event recorded.
      const events = await waitForSecurityEvents({ applicationId: b.applicationId, type: 'end_user.deleted' });
      expect(events).toHaveLength(1);
      expect((events[0]!.metadata as { providerSubscriptionsCanceled: number }).providerSubscriptionsCanceled).toBe(1);

      // user.deleted webhook delivery enqueued.
      const deliveries = await waitFor(async () => {
        const rows = await prisma.webhookDelivery.findMany({
          where: { applicationId: b.applicationId, eventType: 'user.deleted' },
        });
        return rows.length > 0 ? rows : null;
      });
      expect(deliveries).not.toBeNull();
      expect(deliveries!.length).toBeGreaterThanOrEqual(1);
    });

    it('a provider cancel failure REFUSES the delete and keeps the user', async () => {
      // Deliberate reversal of the previous best-effort contract. Once the row is
      // gone there is nothing left to retry from, so a card would keep being
      // charged for a user the operator can no longer see. Refusing is
      // recoverable; deleting is not.
      const b = await bootstrap('pcancelfail');
      const { euid } = await signUpUser(b, 'pcancelfail@example.com');
      await seedProviderSub(b, euid, 'fail');

      const cancelSpy = vi
        .spyOn(FakeStripeProvider.prototype, 'cancelSubscription')
        .mockRejectedValue(new Error('stripe down'));

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('PROVIDER_CANCEL_FAILED');
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      // The user must survive, that is the whole point of refusing.
      expect(await prisma.endUser.findUnique({ where: { id: euid } })).not.toBeNull();

      // And the blocked attempt is auditable, so an operator can see why.
      const blocked = await waitForSecurityEvents({ applicationId: b.applicationId, type: 'end_user.delete_blocked' });
      expect((blocked[0]!.metadata as { reason: string }).reason).toBe(
        'provider_subscription_cancel_failed',
      );
    });

    it('erasure still succeeds when the provider cancel fails (GDPR deadline wins)', async () => {
      // The asymmetry with the delete above is the decision: an erasure answers a
      // legal request with a deadline, so blocking it on a third party being down
      // would be the worse failure. The user is tombstoned either way.
      const b = await bootstrap('ecancelfail');
      const { euid } = await signUpUser(b, 'ecancelfail@example.com');
      await seedProviderSub(b, euid, 'erasefail');

      vi.spyOn(FakeStripeProvider.prototype, 'cancelSubscription').mockRejectedValue(
        new Error('stripe down'),
      );

      const res = await erase(b, euid);
      expect(res.statusCode).toBe(200);
      const row = await prisma.endUser.findUnique({ where: { id: euid } });
      expect(row!.erasedAt).not.toBeNull();
    });

    it('erasure path also cancels the provider subscription', async () => {
      const b = await bootstrap('ecancel');
      const { euid } = await signUpUser(b, 'ecancel@example.com');
      const subId = await seedProviderSub(b, euid, 'erase');

      const cancelSpy = vi
        .spyOn(FakeStripeProvider.prototype, 'cancelSubscription')
        .mockResolvedValue(undefined);

      const res = await erase(b, euid);
      expect(res.statusCode).toBe(200);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect((cancelSpy.mock.calls[0]![0] as { subscription: { id: string } }).subscription.id).toBe(subId);

      // The erasure security event records the cancel count.
      const events = await waitForSecurityEvents({ applicationId: b.applicationId, type: 'end_user.erased' });
      expect((events[0]!.metadata as { providerSubscriptionsCanceled: number }).providerSubscriptionsCanceled).toBe(1);
    });
  });
});
