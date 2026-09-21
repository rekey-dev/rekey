/**
 * Legacy password import. A migration from another auth system is one batch
 * call; bcrypt hashes verify as-is and are upgraded to argon2id on the first
 * successful sign-in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, isBcryptHash, needsRehash, verifyPassword } from '../src/lib/passwords.js';

const PASSWORD = 'pw-one-two-three';

describe('user import and bcrypt verify-and-rehash', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let liveKey: string;
  let pubKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const secret = (): { authorization: string } => ({ authorization: `Bearer ${liveKey}` });
  const publishable = (): { authorization: string } => ({ authorization: `Bearer ${pubKey}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ui-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'UI', slug: `ui-${slug}`, enableBilling: false },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    appId = created.id;
    pubKey = created.publicKey;
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  const signIn = (email: string, password = PASSWORD) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/sign-in', headers: publishable(), payload: { email, password } });

  it('passwords lib: bcrypt verifies, argon2id does not need a rehash, bcrypt does', async () => {
    const bc = await bcrypt.hash(PASSWORD, 4);
    expect(isBcryptHash(bc)).toBe(true);
    expect(needsRehash(bc)).toBe(true);
    expect(await verifyPassword(bc, PASSWORD)).toBe(true);
    expect(await verifyPassword(bc, 'wrong')).toBe(false);
    const ar = await hashPassword(PASSWORD);
    expect(isBcryptHash(ar)).toBe(false);
    expect(needsRehash(ar)).toBe(false);
    expect(await verifyPassword(ar, PASSWORD)).toBe(true);
  });

  it('imports users with bcrypt and argon2id hashes, links OAuth identities, skips duplicates, refuses bad hashes', async () => {
    const bc = await bcrypt.hash(PASSWORD, 4);
    const ar = await hashPassword(PASSWORD);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users/import',
      headers: secret(),
      payload: {
        users: [
          { email: 'Legacy@Example.com', passwordHash: bc, emailVerified: true, metadata: { plan: 'plus' } },
          { email: 'modern@example.com', passwordHash: ar },
          { email: 'social@example.com', oauthIdentities: [{ provider: 'google', providerAccountId: 'g-123' }] },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const { created, skipped } = res.json().data as { created: Array<{ email: string }>; skipped: unknown[] };
    expect(created.map((c) => c.email).sort()).toEqual(['legacy@example.com', 'modern@example.com', 'social@example.com']);
    expect(skipped).toEqual([]);

    const social = await prisma.endUser.findUniqueOrThrow({
      where: { applicationId_email: { applicationId: appId, email: 'social@example.com' } },
      include: { oauthIdentities: true },
    });
    expect(social.passwordHash).toBeNull();
    expect(social.oauthIdentities.map((i) => i.providerAccountId)).toEqual(['g-123']);

    // Re-importing is a no-op that says so.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/users/import',
      headers: secret(),
      payload: { users: [{ email: 'legacy@example.com', passwordHash: ar }] },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.skipped).toEqual([{ email: 'legacy@example.com', reason: 'already_exists' }]);
    const legacy = await prisma.endUser.findUniqueOrThrow({
      where: { applicationId_email: { applicationId: appId, email: 'legacy@example.com' } },
    });
    expect(legacy.passwordHash).toBe(bc); // never overwritten

    // Bad hash refuses the whole batch before any write.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/users/import',
      headers: secret(),
      payload: { users: [{ email: 'ok@example.com' }, { email: 'bad@example.com', passwordHash: 'sha1$deadbeefdeadbeefdeadbeef' }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('PASSWORD_HASH_UNSUPPORTED');
    expect(await prisma.endUser.count({ where: { applicationId: appId, email: 'ok@example.com' } })).toBe(0);

    // A bcrypt hash above the cost ceiling is refused whole, like a bad shape.
    const costly = await app.inject({
      method: 'POST',
      url: '/api/v1/users/import',
      headers: secret(),
      payload: {
        users: [{ email: 'costly@example.com', passwordHash: '$2b$31$' + 'a'.repeat(53) }],
      },
    });
    expect(costly.statusCode).toBe(400);
    expect(costly.json().error.code).toBe('PASSWORD_HASH_UNSUPPORTED');
    // An argon2id hash outside the parameter budget is refused: sign-in would
    // otherwise honour four gigabytes and sixty-four lanes per attempt.
    const hungry = await app.inject({
      method: 'POST',
      url: '/api/v1/users/import',
      headers: secret(),
      payload: { users: [{ email: 'hungry@example.com', passwordHash: '$argon2id$v=19$m=4194304,t=64,p=64$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo' }] },
    });
    expect(hungry.statusCode).toBe(400);
    expect(hungry.json().error.code).toBe('PASSWORD_HASH_UNSUPPORTED');
    // So is an argon2id string that is only a prefix.
    const prefixOnly = await app.inject({
      method: 'POST',
      url: '/api/v1/users/import',
      headers: secret(),
      payload: { users: [{ email: 'prefix@example.com', passwordHash: '$argon2id$not-a-real-hash-at-all' }] },
    });
    expect(prefixOnly.statusCode).toBe(400);
    expect(prefixOnly.json().error.code).toBe('PASSWORD_HASH_UNSUPPORTED');

    // Verified only when the caller says so.
    const modern = await prisma.endUser.findUniqueOrThrow({
      where: { applicationId_email: { applicationId: appId, email: 'modern@example.com' } },
    });
    expect(modern.emailVerified).toBe(false);

    // Duplicate within a batch.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/users/import',
      headers: secret(),
      payload: { users: [{ email: 'x@example.com' }, { email: 'X@example.com' }] },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.code).toBe('IMPORT_DUPLICATE_EMAIL');

    // Publishable key cannot import.
    const pub = await app.inject({ method: 'POST', url: '/api/v1/users/import', headers: publishable(), payload: { users: [{ email: 'p@example.com' }] } });
    expect(pub.statusCode).toBe(401);
  });

  it('an imported bcrypt user signs in with their old password and is upgraded to argon2id', async () => {
    const bc = await bcrypt.hash(PASSWORD, 4);
    await app.inject({
      method: 'POST',
      url: '/api/v1/users/import',
      headers: secret(),
      payload: { users: [{ email: 'up@example.com', passwordHash: bc, emailVerified: true }] },
    });

    const wrong = await signIn('up@example.com', 'not-it');
    expect(wrong.statusCode).toBe(401);
    const stillBcrypt = await prisma.endUser.findUniqueOrThrow({ where: { applicationId_email: { applicationId: appId, email: 'up@example.com' } } });
    expect(isBcryptHash(stillBcrypt.passwordHash!)).toBe(true);

    const ok = await signIn('up@example.com');
    expect(ok.statusCode).toBe(200);
    const upgraded = await prisma.endUser.findUniqueOrThrow({ where: { applicationId_email: { applicationId: appId, email: 'up@example.com' } } });
    expect(upgraded.passwordHash!.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(upgraded.passwordHash, PASSWORD)).toBe(true);

    // And again, on the new hash.
    expect((await signIn('up@example.com')).statusCode).toBe(200);
  });
});
