/**
 * Operator SMTP sends through the real nodemailer against a minimal local
 * SMTP server. The other SMTP tests mock nodemailer, so this is the one place
 * a nodemailer upgrade that changes delivery or its error codes shows up.
 */

import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from '@prisma/client';

vi.mock('../src/lib/ssrf-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/ssrf-guard.js')>();
  return { ...actual, assertSafeHost: vi.fn(async () => ['127.0.0.1']) };
});

const { sendEmail } = await import('../src/lib/email-transport.js');
const { encryptJson } = await import('../src/lib/secrets.js');

interface FakeSmtp {
  server: Server;
  port: number;
  received: string[];
}

async function startFakeSmtp(authReply: string): Promise<FakeSmtp> {
  const received: string[] = [];
  const server = createServer((socket) => {
    let inData = false;
    let data = '';
    socket.on('error', () => {});
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      if (inData) {
        data += chunk.toString();
        if (data.endsWith('\r\n.\r\n')) {
          inData = false;
          received.push(data);
          socket.write('250 queued as fake-id\r\n');
        }
        return;
      }
      for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') socket.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'AUTH') socket.write(authReply);
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, received };
}

function smtpApplication(port: number): Application {
  return {
    id: 'app-smtp-delivery',
    tenantId: 'tenant-smtp-delivery',
    disabledAt: null,
    emailConfig: { fromAddress: 'from@example.com', fromName: 'Acme' },
    emailCredentialsCiphertext: encryptJson({
      provider: 'smtp',
      host: 'smtp.example.com',
      port,
      secure: false,
      user: 'u',
      pass: 'p',
    }),
  } as unknown as Application;
}

const message = { to: 'to@example.com', subject: 'Hello there', html: '<p>x</p>' };

let fake: FakeSmtp | undefined;
afterEach(async () => {
  await new Promise((resolve) => fake?.server.close(resolve) ?? resolve(undefined));
  fake = undefined;
});

describe('SMTP delivery through nodemailer', () => {
  it('delivers the message with the configured sender', async () => {
    fake = await startFakeSmtp('235 ok\r\n');

    const outcome = await sendEmail(smtpApplication(fake.port), message);

    expect(outcome).toMatchObject({ kind: 'sent', via: 'byo_smtp' });
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]).toContain('From: Acme <from@example.com>');
    expect(fake.received[0]).toContain('Subject: Hello there');
  });

  it('reports a rejected login as a credentials problem', async () => {
    fake = await startFakeSmtp('535 authentication failed\r\n');

    const outcome = await sendEmail(smtpApplication(fake.port), message);

    expect(outcome).toMatchObject({
      kind: 'error',
      message: 'SMTP authentication was rejected. Check the username and password.',
    });
  });

  it('reports a refused connection as a connection problem without naming the address', async () => {
    const closed = await startFakeSmtp('235 ok\r\n');
    await new Promise((resolve) => closed.server.close(resolve));

    const outcome = await sendEmail(smtpApplication(closed.port), message);

    expect(outcome).toMatchObject({
      kind: 'error',
      message: 'Could not establish an SMTP connection. Check the host, port and TLS setting.',
    });
  });
});
