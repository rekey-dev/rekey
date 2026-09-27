/**
 * Credentials that travel in a query string stay out of the access log and
 * the request-log table (#416). The invitation preview takes its token as
 * `?token=` and is unauthenticated, so a logged URL was a redeemable invite.
 */

import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { apiLoggerOptions, redactUrlSecrets } from '../src/lib/log-redaction.js';
import { flushApiRequestLogs } from '../src/lib/request-log.js';
import { prisma } from '../src/lib/prisma.js';

const SECRET = 'invite-secret-5f1c9e0d7a';

function capturingStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { stream, lines };
}

describe('redactUrlSecrets', () => {
  it('redacts secret-looking query values and keeps everything else as sent', () => {
    expect(redactUrlSecrets(`/api/v1/tenant/invitations/preview?token=${SECRET}&limit=5`)).toBe(
      '/api/v1/tenant/invitations/preview?token=[REDACTED]&limit=5',
    );
    expect(redactUrlSecrets('/x?code=abc&state=s&api_key=k&mfaChallengeToken=t&invite=i')).toBe(
      '/x?code=[REDACTED]&state=s&api_key=[REDACTED]&mfaChallengeToken=[REDACTED]&invite=[REDACTED]',
    );
    expect(redactUrlSecrets('/x?client_secret=s&access_token=a&key=k&password=p')).toBe(
      '/x?client_secret=[REDACTED]&access_token=[REDACTED]&key=[REDACTED]&password=[REDACTED]',
    );
    expect(redactUrlSecrets('/x?countryCode=IN&keyId=k_1&currencyCode=INR')).toBe(
      '/x?countryCode=IN&keyId=k_1&currencyCode=INR',
    );
    expect(redactUrlSecrets('/x?%74oken=abc')).toBe('/x?%74oken=[REDACTED]');
    expect(redactUrlSecrets('/x?token')).toBe('/x?token=[REDACTED]');
    expect(redactUrlSecrets('/x?limit=5')).toBe('/x?limit=5');
    expect(redactUrlSecrets('/x')).toBe('/x');
  });
});

describe('API request logging', () => {
  it('writes no query-string token to the access log', async () => {
    const { stream, lines } = capturingStream();
    const app = await buildApp({ logger: { ...apiLoggerOptions('info'), stream } });
    await app.ready();
    try {
      const preview = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/invitations/preview?token=${SECRET}`,
      });
      expect(preview.statusCode).toBeGreaterThanOrEqual(400);
      const unmatched = await app.inject({ method: 'GET', url: `/api/v1/no-such-route?token=${SECRET}` });
      expect(unmatched.statusCode).toBe(404);
    } finally {
      await app.close();
    }

    const logged = lines.join('');
    expect(logged).toContain('/api/v1/tenant/invitations/preview?token=[REDACTED]');
    expect(logged).not.toContain(SECRET);
  });

  it('stores no query-string token in the request-log table', async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    try {
      await app.inject({ method: 'GET', url: `/api/v1/tenant/invitations/preview?token=${SECRET}` });
      await app.inject({ method: 'GET', url: `/api/v1/no-such-route?token=${SECRET}` });
    } finally {
      await app.close();
    }
    await flushApiRequestLogs();
    const rows = await prisma.apiRequestLog.findMany({ select: { routePath: true } });
    expect(rows.map((r) => r.routePath)).toContain('/api/v1/tenant/invitations/preview');
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});
