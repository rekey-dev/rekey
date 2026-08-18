/**
 * A FAILED email send must never hand back the raw token.
 *
 * The bug this pins: `{kind:'error'}` (lapsed Resend key, blown quota, network
 * blip) used to fall into the same branch as `{kind:'no_transport'}` — the
 * documented "your server forwards it" contract — so the moment mail broke,
 * every reset / magic-link / verification request started returning a live
 * credential in the JSON body while still answering 200.
 *
 * The invariant is that a BROKEN transport must never yield a token a WORKING
 * transport would have kept private. Both paths withhold, and both report the
 * same status and the same `delivered`.
 *
 * These responses are not byte-identical, and asserting that they were would be
 * wrong: `emailSent` differs on purpose, because it reports transport health so
 * an operator can tell "we mailed it" from "mail is down". Only an existing user
 * reaches either branch, so that field discloses nothing about which addresses
 * have accounts. The field that DOES vary with existence is `delivered`, on the
 * unknown-address path — a pre-existing property of the response contract,
 * documented on `requestPasswordReset` and deliberately not changed here.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('failed email send withholds the token', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let applicationId: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'T-efail', ownerEmail: 't-efail@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    tenantId = tenant.id;

    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId, name: 'efail', slug: 'efail' },
      })
      .then((r) => r.json().data as { id: string });
    applicationId = application.id;

    // `magic-link/request` refuses with 400 unless the method is enabled, which
    // would make the magic-link cases below pass vacuously — the route would
    // never reach the branch under test. Merge into the stored config rather
    // than replacing it: a partial authConfig written straight through Prisma
    // bypasses validation and then 400s whichever route parses it next.
    const stored = await prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { authConfig: true },
    });
    const current = stored.authConfig as { methods?: string[] };
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        authConfig: {
          ...current,
          methods: [...new Set([...(current.methods ?? []), 'magic_link'])],
        } as never,
      },
    });

    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: 'target@example.com', password: 'pw-one-two-three' },
    });
  });

  function post(url: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${liveKey}` },
      payload,
    });
  }

  /** Force the transport to report a send failure. */
  function stubSendError() {
    vi.spyOn(emailService, 'dispatch').mockResolvedValue({
      kind: 'error',
      message: 'resend: 401 api key revoked',
    });
  }

  /** Force a successful delivery. */
  function stubSent() {
    vi.spyOn(emailService, 'dispatch').mockResolvedValue({
      kind: 'sent',
      messageId: 'stub-1',
      via: 'byo_resend',
    });
  }

  const cases = [
    { name: 'forgot-password', url: '/api/v1/auth/forgot-password', field: 'resetToken' },
    {
      name: 'magic-link/request',
      url: '/api/v1/auth/magic-link/request',
      field: 'magicLinkToken',
    },
    { name: 'send-verification', url: '/api/v1/auth/send-verification', field: 'verificationToken' },
  ] as const;

  // send-verification needs a user session; the other two don't. Skipped here
  // and covered by the two that share the exact same fallback branch.
  for (const c of cases.filter((x) => x.name !== 'send-verification')) {
    it(`${c.name}: send error withholds the token exactly as delivery does`, async () => {
      stubSendError();
      const failed = await post(c.url, { email: 'target@example.com' });
      expect(failed.statusCode).toBe(200);
      const failedBody = failed.json().data as Record<string, unknown>;
      expect(failedBody[c.field]).toBeNull();

      vi.restoreAllMocks();
      stubSent();
      const sent = await post(c.url, { email: 'target@example.com' });
      expect(sent.statusCode).toBe(200);
      const sentBody = sent.json().data as Record<string, unknown>;

      // THE invariant: a broken transport must not be a way to obtain a token
      // that a working transport would have kept private. Both paths withhold.
      expect(failedBody[c.field]).toBeNull();
      expect(sentBody[c.field]).toBeNull();

      // Same status and same `delivered` — the two fields a prober could use to
      // learn whether this address has an account. `emailSent` is deliberately
      // NOT compared: it reports transport health, and only an existing user
      // reaches either branch, so it discloses nothing about existence.
      expect(failed.statusCode).toBe(sent.statusCode);
      expect(failedBody.delivered).toBe(sentBody.delivered);
    });

    it(`${c.name}: records auth.email_delivery_failed against the tenant`, async () => {
      stubSendError();
      await post(c.url, { email: 'target@example.com' });

      // Fire-and-forget, so poll until it lands. The old fixed 150ms passed
      // locally and lost on a loaded CI runner.
      const events = await waitForSecurityEvents({
        type: 'auth.email_delivery_failed',
        tenantId,
      });
      expect(events.length).toBeGreaterThan(0);
      // tenantId is what makes it visible: listSecurityEvents filters on it, so
      // a row written without one can never reach the panel.
      expect(events[0]!.tenantId).toBe(tenantId);
      expect(events[0]!.applicationId).toBe(applicationId);
      expect(JSON.stringify(events[0]!.metadata)).not.toContain('target@example.com');
    });
  }

  it('no_transport still returns the raw token to a secret-key caller', async () => {
    // The documented forwarding contract. Withholding on `error` must not have
    // broken the deployment shape that legitimately relies on this.
    vi.spyOn(emailService, 'dispatch').mockResolvedValue({ kind: 'no_transport' });
    const res = await post('/api/v1/auth/forgot-password', { email: 'target@example.com' });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as { resetToken: string | null };
    expect(body.resetToken).toBeTruthy();
    expect(body.resetToken!.length).toBeGreaterThanOrEqual(32);
  });

  it('an unknown email is still indistinguishable from a broken transport', async () => {
    stubSendError();
    const known = await post('/api/v1/auth/forgot-password', { email: 'target@example.com' });
    const unknown = await post('/api/v1/auth/forgot-password', { email: 'nobody@example.com' });
    expect(known.statusCode).toBe(unknown.statusCode);
    // `delivered` legitimately differs (it is the documented enumeration
    // discriminator for the no-user case), but the token field must not.
    expect((known.json().data as { resetToken: unknown }).resetToken).toBeNull();
    expect((unknown.json().data as { resetToken: unknown }).resetToken).toBeNull();
  });
});
