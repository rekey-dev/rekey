/**
 * A browser must not be able to choose the IP the panel reports to the API.
 *
 * The API's per-IP limits on operator sign-in and token refresh key on the
 * single address the panel forwards. Next fills `X-Forwarded-For` from the
 * socket only when the header is ABSENT (`??=`), so with no proxy in front of
 * the panel (the default `docker-compose.yml`, published on :3031) a browser
 * that sent its own header got it forwarded verbatim, and could rotate it for
 * a fresh sign-in budget per attempt.
 *
 * Behind a proxy, the same hole existed one step over: with a hop count set,
 * anything reaching the panel directly (a sibling container on the Docker
 * network) was believed too. The header is now believed only when the proxy
 * also presents `PANEL_PROXY_SECRET`.
 *
 * These tests run the real middleware, apply its header overrides the way
 * Next's router does, then let Next's own fill run, and check what
 * `clientIpFrom` would forward. The last block pins the two Next behaviours
 * that chain relies on.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';
import { clientIpFrom } from '../src/lib/client-ip';

const PEER = '198.51.100.7';

/**
 * What the page render sees: the incoming headers, after the middleware's
 * overrides (`resolve-routes.js`) and Next's socket fill (`base-server.js`).
 */
function renderHeaders(incoming: Record<string, string>, socketPeer: string): Record<string, string | undefined> {
  const req: Record<string, string | undefined> = { ...incoming };
  const res = middleware(new NextRequest('http://panel.test/applications', { headers: incoming }));
  const override = res.headers.get('x-middleware-override-headers');
  if (override !== null) {
    const keep = new Set(override.split(',').map((k) => k.trim()));
    for (const key of Object.keys(req)) if (!keep.has(key)) delete req[key];
    for (const key of keep) req[key] = res.headers.get(`x-middleware-request-${key}`) ?? undefined;
  }
  req['x-forwarded-for'] ??= socketPeer;
  return req;
}

function forwarded(incoming: Record<string, string>, socketPeer: string): string | null {
  const h = renderHeaders(incoming, socketPeer);
  // What api.ts does with the result.
  return clientIpFrom(h['x-forwarded-for'] ?? null);
}

const SECRET = 's3cret-from-traefik';
const PROXY = '10.0.1.2';

afterEach(() => {
  delete process.env.PANEL_TRUSTED_PROXIES;
  delete process.env.PANEL_PROXY_SECRET;
});

describe('no trusted proxy (PANEL_TRUSTED_PROXIES unset or 0)', () => {
  it('a client-supplied X-Forwarded-For cannot change the forwarded IP', () => {
    for (const spoof of ['203.0.113.9', '203.0.113.9, 203.0.113.10', '10.0.0.1']) {
      expect(forwarded({ 'x-forwarded-for': spoof }, PEER)).toBe(PEER);
    }
  });

  it('nor can X-Real-IP', () => {
    expect(forwarded({ 'x-real-ip': '203.0.113.9' }, PEER)).toBe(PEER);
  });

  it('nor can a guessed secret header when no proxy is trusted', () => {
    process.env.PANEL_PROXY_SECRET = SECRET;
    expect(forwarded({ 'x-forwarded-for': '203.0.113.9', 'x-rekey-proxy-secret': SECRET }, PEER)).toBe(PEER);
  });

  it('is the socket peer when the client sent nothing', () => {
    expect(forwarded({}, PEER)).toBe(PEER);
  });

  it('keeps every other header, including the session cookie', () => {
    const h = renderHeaders({ 'x-forwarded-for': '203.0.113.9', cookie: 'rekey_access=a' }, PEER);
    expect(h.cookie).toBe('rekey_access=a');
  });

  it('reads a garbage hop count as 0, the safe setting', () => {
    process.env.PANEL_PROXY_SECRET = SECRET;
    for (const raw of ['', 'yes', '-1', '1.5']) {
      process.env.PANEL_TRUSTED_PROXIES = raw;
      expect(forwarded({ 'x-forwarded-for': '203.0.113.9', 'x-rekey-proxy-secret': SECRET }, PEER)).toBe(PEER);
    }
  });
});

describe('one trusted proxy (PANEL_TRUSTED_PROXIES=1)', () => {
  it('through the proxy: forwards the entry the proxy appended, not the one the client sent', () => {
    process.env.PANEL_TRUSTED_PROXIES = '1';
    process.env.PANEL_PROXY_SECRET = SECRET;
    const via = { 'x-forwarded-for': `203.0.113.9, ${PEER}`, 'x-rekey-proxy-secret': SECRET };
    expect(forwarded(via, PROXY)).toBe(PEER);
  });

  it('straight to the panel (a sibling container, a published port): the peer, whatever the header says', () => {
    process.env.PANEL_TRUSTED_PROXIES = '1';
    process.env.PANEL_PROXY_SECRET = SECRET;
    expect(forwarded({ 'x-forwarded-for': '6.6.6.6' }, PEER)).toBe(PEER);
    expect(forwarded({ 'x-forwarded-for': '6.6.6.6', 'x-rekey-proxy-secret': 'guess' }, PEER)).toBe(PEER);
    expect(forwarded({ 'x-forwarded-for': '6.6.6.6', 'x-rekey-proxy-secret': `${SECRET}x` }, PEER)).toBe(PEER);
    // Same length, one character off.
    const near = `${SECRET.slice(0, -1)}${SECRET.endsWith('t') ? 'u' : 't'}`;
    expect(forwarded({ 'x-forwarded-for': '6.6.6.6', 'x-rekey-proxy-secret': near }, PEER)).toBe(PEER);
    expect(forwarded({ 'x-forwarded-for': '6.6.6.6', 'x-rekey-proxy-secret': SECRET.slice(0, -1) }, PEER)).toBe(PEER);
  });

  it('with no secret configured, never believes the header', () => {
    process.env.PANEL_TRUSTED_PROXIES = '1';
    expect(forwarded({ 'x-forwarded-for': '6.6.6.6', 'x-rekey-proxy-secret': '' }, PEER)).toBe(PEER);
  });

  it('never lets the secret reach the app', () => {
    process.env.PANEL_TRUSTED_PROXIES = '1';
    process.env.PANEL_PROXY_SECRET = SECRET;
    const h = renderHeaders({ 'x-forwarded-for': PEER, 'x-rekey-proxy-secret': SECRET }, PROXY);
    expect(h['x-rekey-proxy-secret']).toBeUndefined();
  });

  it('always forwards one address, never a list', () => {
    process.env.PANEL_TRUSTED_PROXIES = '1';
    process.env.PANEL_PROXY_SECRET = SECRET;
    const via = { 'x-forwarded-for': `1.1.1.1, 2.2.2.2, ${PEER}`, 'x-rekey-proxy-secret': SECRET };
    expect(forwarded(via, PROXY)).toBe(PEER);
  });
});

describe('Cloudflare in front of Traefik (PANEL_TRUSTED_PROXIES=2)', () => {
  const EDGE = '104.21.20.128';

  it('forwards the client Cloudflare saw, not the Cloudflare edge', () => {
    process.env.PANEL_TRUSTED_PROXIES = '2';
    process.env.PANEL_PROXY_SECRET = SECRET;
    const via = { 'x-forwarded-for': `203.0.113.9, ${PEER}, ${EDGE}`, 'x-rekey-proxy-secret': SECRET };
    expect(forwarded(via, PROXY)).toBe(PEER);
  });

  it('a chain shorter than configured is not believed (Traefik not trusting Cloudflare leaves one entry)', () => {
    process.env.PANEL_TRUSTED_PROXIES = '2';
    process.env.PANEL_PROXY_SECRET = SECRET;
    expect(forwarded({ 'x-forwarded-for': EDGE, 'x-rekey-proxy-secret': SECRET }, PROXY)).toBe(PROXY);
  });
});

describe('whether the forwarded address is the visitor', () => {
  const source = (incoming: Record<string, string>) =>
    renderHeaders(incoming, PEER)['x-rekey-internal-client-ip-source'];

  it('no proxy trusted: the peer is the visitor', () => {
    expect(source({ 'x-forwarded-for': '6.6.6.6' })).toBe('peer');
  });

  it('a proxy that proved itself: its reported visitor', () => {
    process.env.PANEL_TRUSTED_PROXIES = '1';
    process.env.PANEL_PROXY_SECRET = SECRET;
    expect(source({ 'x-forwarded-for': `6.6.6.6, ${PEER}`, 'x-rekey-proxy-secret': SECRET })).toBe('proxy');
  });

  it('a proxy expected but not proven, or a short chain: not the visitor', () => {
    process.env.PANEL_TRUSTED_PROXIES = '2';
    process.env.PANEL_PROXY_SECRET = SECRET;
    expect(source({ 'x-forwarded-for': '6.6.6.6' })).toBe('none');
    expect(source({ 'x-forwarded-for': PEER, 'x-rekey-proxy-secret': SECRET })).toBe('none');
  });

  it('a client cannot claim it', () => {
    process.env.PANEL_TRUSTED_PROXIES = '1';
    process.env.PANEL_PROXY_SECRET = SECRET;
    expect(source({ 'x-forwarded-for': '6.6.6.6', 'x-rekey-internal-client-ip-source': 'proxy' })).toBe('none');
  });
});

describe('installed Next runtime', () => {
  const nextDir = path.dirname(createRequire(import.meta.url).resolve('next/package.json'));
  const read = (rel: string) => readFileSync(path.join(nextDir, 'dist', rel), 'utf8');

  it('fills X-Forwarded-For from the socket only when the header is absent', () => {
    // If Next started APPENDING the peer instead, the rightmost read would
    // still be right; if it started trusting the header outright, the middleware
    // delete would still cover it. What this pins is the reason the delete is
    // needed at all, and that deleting it makes the fill happen.
    expect(read('server/base-server.js')).toMatch(
      /req\.headers\['x-forwarded-for'\] \?\?= [^;]*socket[^;]*remoteAddress/,
    );
  });

  it('removes request headers the middleware override leaves out', () => {
    expect(read('server/lib/router-utils/resolve-routes.js')).toMatch(
      /for \(const key of Object\.keys\(req\.headers\)\)\{\s*if \(!overriddenHeaders\.has\(key\)\) \{\s*delete req\.headers\[key\];/,
    );
  });
});

describe('startup warning for a hop count with no secret', () => {
  it('warns when a proxy is trusted but no secret is set', async () => {
    const { proxyConfigWarning } = await import('../src/lib/client-ip');
    expect(proxyConfigWarning({ PANEL_TRUSTED_PROXIES: '1' })).toMatch(/PANEL_PROXY_SECRET is not set/);
    expect(proxyConfigWarning({ PANEL_TRUSTED_PROXIES: '2', PANEL_PROXY_SECRET: '  ' })).toMatch(/PANEL_TRUSTED_PROXIES=2/);
  });

  it('is quiet when the configuration is coherent', async () => {
    const { proxyConfigWarning } = await import('../src/lib/client-ip');
    expect(proxyConfigWarning({})).toBeNull();
    expect(proxyConfigWarning({ PANEL_TRUSTED_PROXIES: '0' })).toBeNull();
    expect(proxyConfigWarning({ PANEL_TRUSTED_PROXIES: '1', PANEL_PROXY_SECRET: 'x' })).toBeNull();
  });

  it('is logged once, at startup, on the Node runtime only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saved = { ...process.env };
    try {
      process.env.PANEL_TRUSTED_PROXIES = '1';
      delete process.env.PANEL_PROXY_SECRET;
      const { register } = await import('../src/instrumentation');
      process.env.NEXT_RUNTIME = 'edge';
      await register();
      expect(warn).not.toHaveBeenCalled();
      process.env.NEXT_RUNTIME = 'nodejs';
      await register();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      process.env = saved;
      warn.mockRestore();
    }
  });
});
