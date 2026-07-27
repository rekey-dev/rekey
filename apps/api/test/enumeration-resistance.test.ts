/**
 * A publishable caller must not be able to tell whether an email has an account.
 *
 * The publishable key ships in browser bundles, so "an attacker can reach this"
 * means "anyone who opens devtools can". `forgot-password` used to answer
 * `delivered: false` for an unknown address and `true` for a known one, which is
 * a complete account-existence oracle on a public endpoint.
 *
 * The rule now: for a publishable caller these endpoints return ONE body, always.
 * A secret-key caller still gets the truth, because the no-transport contract
 * hands it the raw token to forward and it has to be able to tell "no such user"
 * from "here is the token".
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('publishable callers cannot enumerate accounts', () => {
  let app: FastifyInstance;
  let publicKey: string;
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
    const slug = `enum-${Math.random().toString(36).slice(2, 8)}`;
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: slug, ownerEmail: `op-${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });

    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: slug, slug },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    publicKey = application.publicKey;

    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    // magic_link needs enabling, merged into the stored config so the write
    // stays valid — a partial authConfig 400s whichever route parses it next.
    const stored = await prisma.application.findUniqueOrThrow({
      where: { id: application.id },
      select: { authConfig: true },
    });
    const current = stored.authConfig as { methods?: string[] };
    await prisma.application.update({
      where: { id: application.id },
      data: {
        authConfig: {
          ...current,
          methods: [...new Set([...(current.methods ?? []), 'magic_link'])],
        } as never,
      },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: 'known@example.com', password: 'pw-one-two-three' },
    });
  });

  const post = (url: string, key: string, email: string) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${key}` }, payload: { email } });

  for (const url of ['/api/v1/auth/forgot-password', '/api/v1/auth/magic-link/request']) {
    it(`${url}: a known and an unknown address are byte-identical to a browser`, async () => {
      const known = await post(url, publicKey, 'known@example.com');
      const unknown = await post(url, publicKey, 'nobody@example.com');
      expect(known.statusCode).toBe(unknown.statusCode);
      // THE assertion: no field varies with account existence.
      expect(known.json().data).toEqual(unknown.json().data);
    });

    it(`${url}: a broken transport is also indistinguishable to a browser`, async () => {
      // Otherwise an attacker learns "this address exists" from the fact that a
      // send was even attempted.
      const baseline = await post(url, publicKey, 'nobody@example.com');
      vi.spyOn(emailService, 'dispatch').mockResolvedValue({
        kind: 'error',
        message: 'resend: 401',
      });
      const broken = await post(url, publicKey, 'known@example.com');
      expect(broken.json().data).toEqual(baseline.json().data);
    });

    it(`${url}: never hands a browser a token`, async () => {
      const res = await post(url, publicKey, 'known@example.com');
      const body = res.json().data as Record<string, unknown>;
      expect(body.resetToken ?? null).toBeNull();
      expect(body.magicLinkToken ?? null).toBeNull();
    });
  }

  it('a SECRET-key caller still learns the truth — the forwarding contract needs it', async () => {
    vi.spyOn(emailService, 'dispatch').mockResolvedValue({ kind: 'no_transport' });
    const known = await post('/api/v1/auth/forgot-password', liveKey, 'known@example.com');
    const unknown = await post('/api/v1/auth/forgot-password', liveKey, 'nobody@example.com');

    // The whole point of the secret tier: it gets the raw token to forward, so it
    // must be able to tell "no such user" from "here it is".
    expect((known.json().data as { resetToken: string | null }).resetToken).toBeTruthy();
    expect((unknown.json().data as { resetToken: string | null }).resetToken).toBeNull();
    expect((unknown.json().data as { delivered: boolean }).delivered).toBe(false);
  });
});
