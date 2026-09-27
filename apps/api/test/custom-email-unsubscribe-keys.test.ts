/**
 * Unsubscribe token keys: a dedicated secret signs, rotated-out secrets and the
 * JWT_SECRET-derived key still verify, and nothing else does. `env` is parsed
 * once, so the config module is mocked for this file.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      EMAIL_UNSUBSCRIBE_SECRET: 'current-secret-current-secret-current-secret',
      EMAIL_UNSUBSCRIBE_SECRET_ID: 'k2',
      EMAIL_UNSUBSCRIBE_PREVIOUS_SECRETS: 'k1:previous-secret-previous-secret-previous, broken',
    },
  };
});

const { createHmac } = await import('node:crypto');
const { createUnsubscribeToken, verifyUnsubscribeToken } = await import(
  '../src/modules/email/custom/unsubscribe-token.js'
);
const { fromHeader } = await import('../src/lib/email-transport.js');

function signWith(keyId: string, key: Buffer | string, body: object): string {
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = createHmac('sha256', key).update(`${keyId}.${payload}`).digest('base64url');
  return `${keyId}.${payload}.${sig}`;
}

const BODY = { a: 'app_1', e: 'a@example.com', c: 'notification' };

describe('unsubscribe token keys', () => {
  it('signs with the current key id', () => {
    const token = createUnsubscribeToken('app_1', 'A@Example.com');
    expect(token.startsWith('k2.')).toBe(true);
    expect(verifyUnsubscribeToken(token)).toEqual({ applicationId: 'app_1', address: 'a@example.com', category: 'notification' });
  });

  it('still accepts a rotated-out key and the JWT_SECRET-derived key', () => {
    expect(verifyUnsubscribeToken(signWith('k1', 'previous-secret-previous-secret-previous', BODY))).not.toBeNull();
    const derived = createHmac('sha256', process.env.JWT_SECRET!).update('rekey:email-unsubscribe:v1').digest();
    expect(verifyUnsubscribeToken(signWith('jwt', derived, BODY))).not.toBeNull();
  });

  it('refuses an unknown key id, a key signed under another id, and a token without the category', () => {
    expect(verifyUnsubscribeToken(signWith('k9', 'previous-secret-previous-secret-previous', BODY))).toBeNull();
    expect(verifyUnsubscribeToken(signWith('k2', 'previous-secret-previous-secret-previous', BODY))).toBeNull();
    expect(verifyUnsubscribeToken(signWith('broken', '', BODY))).toBeNull();
    expect(
      verifyUnsubscribeToken(signWith('k2', 'current-secret-current-secret-current-secret', { a: 'app_1', e: 'a@example.com' })),
    ).toBeNull();
  });
});

describe('From display name quoting (RFC 5322)', () => {
  it('quotes a name with specials and leaves a plain one alone', () => {
    expect(fromHeader('a@x.test', 'Acme')).toBe('Acme <a@x.test>');
    expect(fromHeader('a@x.test', 'Acme, Inc.')).toBe('"Acme, Inc." <a@x.test>');
    expect(fromHeader('a@x.test', 'Acme (via Rekey)')).toBe('"Acme (via Rekey)" <a@x.test>');
    expect(fromHeader('a@x.test', 'Say "hi" \\ bye')).toBe('"Say \\"hi\\" \\\\ bye" <a@x.test>');
    expect(fromHeader('a@x.test', 'Line\r\nBcc: x@y')).toBe('"Line Bcc: x@y" <a@x.test>');
    expect(fromHeader('a@x.test', undefined)).toBe('a@x.test');
  });
});
