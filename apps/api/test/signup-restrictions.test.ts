/**
 * `authConfig.signupRestrictions`: which email domains may self sign-up.
 *
 * Every self sign-up path is refused for a blocked domain with 403
 * SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED; the magic-link REQUEST stays silent so it
 * cannot be used to probe the rules; users an operator creates or imports are
 * never checked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AuthConfigSchema, SignupRestrictionsSchema } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import { GoogleProvider } from '../src/modules/oauth/providers/google.js';
import { isDisposableDomain } from '../src/lib/disposable-domains.js';

describe('sign-up email domain rules', () => {
  let app: FastifyInstance;
  let tenantToken: string;
  let applicationId: string;
  let publicKey: string;
  let secretKey: string;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    registerOAuthProvider(new GoogleProvider());
    await app.close();
  });

  beforeEach(async () => {
    n += 1;
    tenantToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${n}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${n}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: { name: 'Rules', slug: `signup-rules-${n}` },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    applicationId = created.id;
    publicKey = created.publicKey;
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await applicationsService.updateAuthConfig({
      applicationId,
      patch: { methods: ['password', 'magic_link'] },
    });
  });

  function patchAuthConfig(body: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: { authorization: `Bearer ${tenantToken}` },
      payload: body,
    });
  }

  async function restrict(signupRestrictions: Record<string, unknown>) {
    const res = await patchAuthConfig({ signupRestrictions });
    expect(res.statusCode, res.body).toBe(200);
  }

  function signUp(key: string, email: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${key}` },
      payload: { email, password: 'correct-horse-battery' },
    });
  }

  function requestMagicLink(key: string, email: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: { authorization: `Bearer ${key}` },
      payload: { email },
    });
  }

  function expectDomainRefusal(res: { statusCode: number; json(): unknown }) {
    expect(res.statusCode).toBe(403);
    const error = (res.json() as { error: { code: string; message: string; fix: string } }).error;
    expect(error.code).toBe('SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED');
    expect(error.fix).toContain('authConfig.signupRestrictions');
    return error;
  }

  async function userExists(email: string) {
    return (
      (await prisma.endUser.findUnique({
        where: { applicationId_email: { applicationId, email } },
      })) !== null
    );
  }

  describe('password sign-up', () => {
    it('refuses a blocked domain and creates nothing', async () => {
      await restrict({ blockedDomains: ['blocked.test'] });
      expectDomainRefusal(await signUp(publicKey, 'a@blocked.test'));
      expect(await userExists('a@blocked.test')).toBe(false);
    });

    it('refuses a blocked domain for a secret key too', async () => {
      await restrict({ blockedDomains: ['blocked.test'] });
      expectDomainRefusal(await signUp(secretKey, 'a@Blocked.TEST'));
    });

    it('with an allowlist, admits only the listed domains, and the refusal never names them', async () => {
      await restrict({ allowedDomains: ['acme-corp.test'] });
      expect((await signUp(publicKey, 'ok@acme-corp.test')).statusCode).toBe(201);
      const error = expectDomainRefusal(await signUp(publicKey, 'no@other.test'));
      expect(JSON.stringify(error)).not.toContain('acme-corp');
    });

    it('matches *.example.com against subdomains only', async () => {
      await restrict({ allowedDomains: ['*.acme-corp.test'] });
      expect((await signUp(publicKey, 'ok@eu.acme-corp.test')).statusCode).toBe(201);
      expectDomainRefusal(await signUp(publicKey, 'apex@acme-corp.test'));
    });

    it('a blocked domain wins over an allowed one', async () => {
      await restrict({ allowedDomains: ['*.acme-corp.test'], blockedDomains: ['contractors.acme-corp.test'] });
      expectDomainRefusal(await signUp(publicKey, 'x@contractors.acme-corp.test'));
    });

    it('blocks a disposable domain, and its subdomains, only when switched on', async () => {
      expect((await signUp(publicKey, 'before@mailinator.com')).statusCode).toBe(201);
      await restrict({ blockDisposable: true });
      expectDomainRefusal(await signUp(publicKey, 'after@mailinator.com'));
      expectDomainRefusal(await signUp(publicKey, 'after@eu.mailinator.com'));
      expect((await signUp(publicKey, 'real@example.com')).statusCode).toBe(201);
    });

    it('still signs an existing user in on a now-blocked domain', async () => {
      expect((await signUp(publicKey, 'old@blocked.test')).statusCode).toBe(201);
      await restrict({ blockedDomains: ['blocked.test'] });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${publicKey}` },
        payload: { email: 'old@blocked.test', password: 'correct-horse-battery' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('magic link', () => {
    it('the request for a blocked new address is indistinguishable from an allowed one', async () => {
      await restrict({ blockedDomains: ['blocked.test'] });
      const allowed = await requestMagicLink(publicKey, 'new@allowed.test');
      const blocked = await requestMagicLink(publicKey, 'new@blocked.test');
      expect(blocked.statusCode).toBe(allowed.statusCode);
      expect(blocked.json()).toEqual(allowed.json());
      expect(await prisma.magicLinkToken.count({ where: { email: 'new@blocked.test' } })).toBe(0);
    });

    it('consuming a link minted before the rule changed is refused at creation', async () => {
      const minted = await requestMagicLink(secretKey, 'late@blocked.test');
      const token = (minted.json().data as { magicLinkToken: string | null }).magicLinkToken;
      expect(token).toBeTruthy();
      await restrict({ blockedDomains: ['blocked.test'] });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/verify',
        headers: { authorization: `Bearer ${publicKey}` },
        payload: { token },
      });
      expectDomainRefusal(res);
      expect(await userExists('late@blocked.test')).toBe(false);
    });
  });

  describe('OAuth-first sign-up', () => {
    it('refuses to create a user on a blocked domain', async () => {
      await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${applicationId}/oauth-config/google`,
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: {
          clientId: 'gid',
          clientSecret: 'gsecret',
          redirectUri: 'https://app.example/oauth/google/callback',
        },
      });
      registerOAuthProvider({
        name: 'google',
        buildAuthUrl: () => 'https://mock.example/start',
        exchange: async () => ({
          providerAccountId: `g-blocked-${n}`,
          email: 'social@blocked.test',
          emailVerified: true,
        }),
      });
      await restrict({ blockedDomains: ['blocked.test'] });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/oauth/google/callback',
        headers: { authorization: `Bearer ${secretKey}` },
        payload: { code: 'mock-code' },
      });
      expectDomainRefusal(res);
      expect(await userExists('social@blocked.test')).toBe(false);
    });
  });

  describe('operator-created and imported users skip the rules', () => {
    it('the operator create route creates a user on a blocked domain', async () => {
      await restrict({ blockedDomains: ['blocked.test'], blockDisposable: true });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/end-users`,
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: { email: 'staff@blocked.test' },
      });
      expect(res.statusCode, res.body).toBe(201);
    });

    it('the import route imports a user on a blocked domain', async () => {
      await restrict({ allowedDomains: ['acme-corp.test'] });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users/import',
        headers: { authorization: `Bearer ${secretKey}` },
        payload: { users: [{ email: 'legacy@elsewhere.test' }] },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await userExists('legacy@elsewhere.test')).toBe(true);
    });
  });

  describe('validation', () => {
    it('lowercases, converts IDN to punycode, and de-duplicates', async () => {
      await restrict({ allowedDomains: ['Acme-Corp.TEST', 'acme-corp.test', 'bücher.de', '*.Eu.Acme-Corp.test'] });
      const row = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(AuthConfigSchema.parse(row.authConfig).signupRestrictions).toEqual({
        allowedDomains: ['acme-corp.test', 'xn--bcher-kva.de', '*.eu.acme-corp.test'],
      });
    });

    it.each([['*example.com'], ['ex*ample.com'], ['*'], ['localhost'], ['a b.com'], ['user@example.com'], ['example.com/path'], ['1.2.3.4']])(
      'refuses %s',
      async (rule) => {
        const res = await patchAuthConfig({ signupRestrictions: { blockedDomains: [rule] } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
      },
    );

    it('caps each list at 500 entries', async () => {
      const list = Array.from({ length: 501 }, (_, i) => `d${i}.test`);
      expect((await patchAuthConfig({ signupRestrictions: { blockedDomains: list } })).statusCode).toBe(400);
      expect(
        (await patchAuthConfig({ signupRestrictions: { blockedDomains: list.slice(0, 500) } })).statusCode,
      ).toBe(200);
    });

    it('refuses an unknown key inside signupRestrictions', () => {
      expect(SignupRestrictionsSchema.safeParse({ allowDomains: ['a.test'] }).success).toBe(false);
    });

    it('null clears the rules', async () => {
      await restrict({ blockedDomains: ['blocked.test'] });
      expect((await patchAuthConfig({ signupRestrictions: null })).statusCode).toBe(200);
      const row = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect(AuthConfigSchema.parse(row.authConfig).signupRestrictions).toBeUndefined();
      expect((await signUp(publicKey, 'a@blocked.test')).statusCode).toBe(201);
    });
  });

  it('the vendored disposable list matches parents and not look-alikes', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('a.b.mailinator.com')).toBe(true);
    expect(isDisposableDomain('mailinator.example-corp.test')).toBe(false);
    expect(isDisposableDomain('gmail.com')).toBe(false);
  });
});
