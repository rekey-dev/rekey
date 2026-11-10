/**
 * The API refuses a publishable key without an allowlisted Origin whenever the
 * Application has an origin allowlist, and it allows the portal by the origin
 * of its PUBLIC_PORTAL_URL. The portal's server-side calls must send exactly
 * that string.
 */

import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { publishableKeyCallHeaders } from '@/lib/client-ip';

const savedBaseUrl = process.env.PORTAL_BASE_URL;
afterEach(() => {
  if (savedBaseUrl === undefined) delete process.env.PORTAL_BASE_URL;
  else process.env.PORTAL_BASE_URL = savedBaseUrl;
});

describe('publishableKeyCallHeaders', () => {
  it("sends the portal's own origin, without path or trailing slash", async () => {
    process.env.PORTAL_BASE_URL = 'https://portal.example.com/';
    expect((await publishableKeyCallHeaders()).origin).toBe('https://portal.example.com');

    process.env.PORTAL_BASE_URL = 'http://localhost:3050/base/path';
    expect((await publishableKeyCallHeaders()).origin).toBe('http://localhost:3050');
  });

  it('delivers the Origin header over a real socket from Node fetch', async () => {
    process.env.PORTAL_BASE_URL = 'https://portal.example.com';
    let received: IncomingHttpHeaders = {};
    const server = createServer((req, res) => {
      received = req.headers;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await fetch(`http://127.0.0.1:${port}/`, { headers: await publishableKeyCallHeaders() });
    } finally {
      server.close();
    }
    expect(received.origin).toBe('https://portal.example.com');
  });
});
