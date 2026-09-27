/**
 * Operator SMTP connects to the address the SSRF guard approved, not to the
 * hostname (#416). Nodemailer resolves a hostname itself, so a short-TTL
 * record could pass the guard with a public address and then send the
 * connection to an internal one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from '@prisma/client';

const smtp = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: smtp.createTransport } }));

vi.mock('../src/lib/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/ssrf-guard.js')>();
  return { ...actual, assertSafeHost: vi.fn(actual.assertSafeHost) };
});

const { assertSafeHost } = await import('../src/lib/ssrf-guard.js');
const { sendEmail, pinnedSmtpHost } = await import('../src/lib/email-transport.js');
const { encryptJson } = await import('../src/lib/secrets.js');

const PUBLIC_IP = '93.184.216.34';

afterEach(() => {
  vi.clearAllMocks();
});

describe('assertSafeHost', () => {
  it('returns the addresses it approved', async () => {
    await expect(assertSafeHost(PUBLIC_IP, { allowPrivate: false })).resolves.toEqual([PUBLIC_IP]);
  });

  it('still refuses a private address', async () => {
    await expect(assertSafeHost('10.0.0.5', { allowPrivate: false })).rejects.toThrow();
  });
});

describe('pinnedSmtpHost', () => {
  it('prefers an IPv4 address when the resolver lists an AAAA first', () => {
    expect(pinnedSmtpHost('smtp.example.com', ['2606:2800:220:1::1', PUBLIC_IP])).toEqual({
      host: PUBLIC_IP,
      servername: 'smtp.example.com',
    });
  });

  it('uses an IPv6 address when that is all there is', () => {
    expect(pinnedSmtpHost('smtp.example.com', ['2606:2800:220:1::1'])).toEqual({
      host: '2606:2800:220:1::1',
      servername: 'smtp.example.com',
    });
  });

  it('sets no servername for an IP literal, and keeps the host when nothing was resolved', () => {
    expect(pinnedSmtpHost(PUBLIC_IP, [PUBLIC_IP])).toEqual({ host: PUBLIC_IP });
    expect(pinnedSmtpHost('smtp.internal', [])).toEqual({ host: 'smtp.internal' });
  });
});

describe('SMTP send', () => {
  it('connects to the approved address and keeps TLS on the configured hostname', async () => {
    vi.mocked(assertSafeHost).mockResolvedValueOnce([PUBLIC_IP]);
    smtp.createTransport.mockReturnValue({
      sendMail: vi.fn(async () => ({ messageId: 'm-1' })),
      close: vi.fn(),
    });
    const application = {
      id: 'app-smtp-pin',
      tenantId: 'tenant-smtp-pin',
      disabledAt: null,
      emailConfig: { fromAddress: 'from@example.com' },
      emailCredentialsCiphertext: encryptJson({
        provider: 'smtp',
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'u',
        pass: 'p',
      }),
    } as unknown as Application;

    const outcome = await sendEmail(application, { to: 'to@example.com', subject: 's', html: '<p>x</p>' });

    expect(outcome.kind).toBe('sent');
    expect(smtp.createTransport).toHaveBeenCalledTimes(1);
    expect(smtp.createTransport.mock.calls[0]![0]).toMatchObject({
      host: PUBLIC_IP,
      servername: 'smtp.example.com',
    });
  });
});
