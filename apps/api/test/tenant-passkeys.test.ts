/**
 * Operator passkeys (tenant-side WebAuthn).
 *
 * Coverage:
 *   - GET /passkeys requires session
 *   - GET /passkeys returns empty list for fresh user
 *   - DELETE /passkeys/:id refuses for non-owner
 *   - register/start returns WEBAUTHN_NOT_CONFIGURED when env unset
 *   - register/start returns options when env configured
 *
 * `register/start` requires a step-up proof (`password` or a current
 * authenticator code) as of 2.0.0-rc.3 — these cases send the password so they
 * keep testing the RP-config resolution they are about. The step-up itself is
 * pinned in test/auth-hardening-operator.test.ts.
 *
 * Full ceremonies (register/complete + authenticate/complete) need a real
 * authenticator simulator — out of scope for in-process tests. Those
 * paths are smoke-covered via the service unit shape on the panel side.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

interface SessionResult {
  user: { id: string; email: string };
  accessToken: string;
}

describe('Operator passkeys', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUp(email: string): Promise<SessionResult> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName: 'WS' },
    });
    expect(r.statusCode).toBe(201);
    return r.json().data as SessionResult;
  }

  beforeEach(() => {
    delete process.env.PANEL_WEBAUTHN_RP_ID;
    delete process.env.PANEL_WEBAUTHN_RP_ORIGINS;
    delete process.env.PANEL_WEBAUTHN_RP_NAME;
    // The RP config can also be derived from CORS_ALLOWED_ORIGINS — clear it so
    // the "unset" cases are deterministic regardless of cross-suite leakage.
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    delete process.env.PANEL_WEBAUTHN_RP_ID;
    delete process.env.PANEL_WEBAUTHN_RP_ORIGINS;
    delete process.env.PANEL_WEBAUTHN_RP_NAME;
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  it('GET /passkeys requires session', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/passkeys',
    });
    expect(r.statusCode).toBe(401);
  });

  it('GET /passkeys returns empty list for a fresh operator', async () => {
    const session = await signUp('pk-empty@example.com');
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/passkeys',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.passkeys).toEqual([]);
  });

  it('register/start refuses with WEBAUTHN_NOT_CONFIGURED when env unset', async () => {
    const session = await signUp('pk-not-config@example.com');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/passkeys/register/start',
      headers: { authorization: `Bearer ${session.accessToken}` },
      // The route now demands a step-up before it will start a ceremony:
      // an operator passkey signs its holder in with no password and no second
      // factor, so a panel session alone must not be able to enroll one.
      payload: { password: 'pw-one-two-three' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('WEBAUTHN_NOT_CONFIGURED');
  });

  it('register/start returns options when env configured', async () => {
    process.env.PANEL_WEBAUTHN_RP_ID = 'panel.test';
    process.env.PANEL_WEBAUTHN_RP_ORIGINS = 'https://panel.test';
    process.env.PANEL_WEBAUTHN_RP_NAME = 'Rekey Panel';

    const session = await signUp('pk-configured@example.com');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/passkeys/register/start',
      headers: { authorization: `Bearer ${session.accessToken}` },
      // The route now demands a step-up before it will start a ceremony:
      // an operator passkey signs its holder in with no password and no second
      // factor, so a panel session alone must not be able to enroll one.
      payload: { password: 'pw-one-two-three' },
    });
    expect(r.statusCode).toBe(200);
    const data = r.json().data;
    expect(typeof data.expectedChallenge).toBe('string');
    expect(data.options.rp.id).toBe('panel.test');
    expect(data.options.rp.name).toBe('Rekey Panel');
  });

  it('register/start derives the RP from CORS_ALLOWED_ORIGINS when PANEL_WEBAUTHN_* is unset', async () => {
    // No PANEL_WEBAUTHN_* set — fall back to the panel origin in the CORS list.
    // The `panel.` host is preferred over the bare marketing origin.
    process.env.CORS_ALLOWED_ORIGINS = 'https://rekey.dev,https://panel.rekey.dev';

    const session = await signUp('pk-cors-derive@example.com');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/passkeys/register/start',
      headers: { authorization: `Bearer ${session.accessToken}` },
      // The route now demands a step-up before it will start a ceremony:
      // an operator passkey signs its holder in with no password and no second
      // factor, so a panel session alone must not be able to enroll one.
      payload: { password: 'pw-one-two-three' },
    });
    expect(r.statusCode).toBe(200);
    const data = r.json().data;
    expect(data.options.rp.id).toBe('panel.rekey.dev');
  });

  it('DELETE /passkeys/:id refuses for a passkey owned by a different operator', async () => {
    process.env.PANEL_WEBAUTHN_RP_ID = 'panel.test';
    process.env.PANEL_WEBAUTHN_RP_ORIGINS = 'https://panel.test';

    const alice = await signUp('pk-alice@example.com');
    const bob = await signUp('pk-bob@example.com');

    // Manually insert a credential owned by Alice so we exercise the
    // ownership guard without driving a full ceremony.
    const cred = await prisma.tenantWebAuthnCredential.create({
      data: {
        tenantUserId: alice.user.id,
        credentialId: 'cred-alice-1',
        publicKey: 'AAAA',
        counter: 0n,
        transports: [],
        deviceName: 'Alice laptop',
      },
    });

    const r = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/passkeys/${cred.id}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('PASSKEY_NOT_FOUND');

    // Owner can still see + delete.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/passkeys',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.passkeys).toHaveLength(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/passkeys/${cred.id}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(del.statusCode).toBe(200);
  });

  // --- Anti-replay: server-side challenge store (security regression) ---

  it('authenticate/complete rejects a challenge that was never issued', async () => {
    process.env.PANEL_WEBAUTHN_RP_ID = 'panel.test';
    process.env.PANEL_WEBAUTHN_RP_ORIGINS = 'https://panel.test';

    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/passkeys/authenticate/complete',
      payload: {
        // Attacker-fabricated challenge value — must not be trusted.
        expectedChallenge: 'this-challenge-was-never-minted-by-the-server',
        response: { id: 'whatever' },
      },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('WEBAUTHN_CHALLENGE_INVALID');
  });

  it('authenticate challenge is single-use — a replay is rejected', async () => {
    process.env.PANEL_WEBAUTHN_RP_ID = 'panel.test';
    process.env.PANEL_WEBAUTHN_RP_ORIGINS = 'https://panel.test';

    // 1. Mint a real challenge via /start (server persists it).
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/passkeys/authenticate/start',
    });
    expect(start.statusCode).toBe(200);
    const challenge = start.json().data.expectedChallenge as string;
    expect(typeof challenge).toBe('string');

    // 2. First completion burns the challenge. The dummy credential id won't
    //    resolve, so we stop at PASSKEY_UNKNOWN — but the challenge is consumed.
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/passkeys/authenticate/complete',
      payload: { expectedChallenge: challenge, response: { id: 'no-such-credential' } },
    });
    expect(first.statusCode).toBe(401);
    expect(first.json().error.code).toBe('PASSKEY_UNKNOWN');

    // 3. Replaying the SAME challenge now fails at the store — proving a
    //    captured assertion can't be replayed even with a valid signature.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/passkeys/authenticate/complete',
      payload: { expectedChallenge: challenge, response: { id: 'no-such-credential' } },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('WEBAUTHN_CHALLENGE_INVALID');
  });
});
