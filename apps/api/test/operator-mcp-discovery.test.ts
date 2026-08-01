/**
 * Operator MCP OAuth 2.1 authorization server — discovery metadata
 * (RFC 8414 / 9728) in BOTH the suffix form and the root-level "path-insertion"
 * form a strict connector (Claude custom connectors) constructs. The
 * path-insertion routes are what unblock Claude connector setup; without them
 * discovery 404s and the connector reports "Couldn't register".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('Operator MCP OAuth AS — discovery', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('authorization-server metadata (RFC 8414) at the suffix URL', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/mcp/.well-known/oauth-authorization-server',
    });
    expect(r.statusCode).toBe(200);
    const md = r.json() as Record<string, unknown>;
    expect(md.issuer).toContain('/api/v1/tenant/mcp');
    expect(md.registration_endpoint).toContain('/oauth/register');
    expect(md.code_challenge_methods_supported).toEqual(['S256']);
    expect(md.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  // ---- Root-level "path-insertion" discovery (RFC 8414 / 9728) ----
  // A strict connector inserts the well-known segment right after the origin
  // and re-appends the issuer path:
  //   /.well-known/oauth-authorization-server/api/v1/tenant/mcp

  it('authorization-server metadata at the path-insertion URL is identical to the suffix form', async () => {
    const suffix = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/mcp/.well-known/oauth-authorization-server',
    });
    const inserted = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server/api/v1/tenant/mcp',
    });
    expect(inserted.statusCode).toBe(200);
    // Byte-identical body to the suffix form.
    expect(inserted.body).toBe(suffix.body);
    const md = inserted.json() as Record<string, unknown>;
    expect(md.issuer).toContain('/api/v1/tenant/mcp');
  });

  it('protected-resource metadata at the path-insertion URL is identical to the suffix form', async () => {
    const suffix = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/mcp/.well-known/oauth-protected-resource',
    });
    const inserted = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/api/v1/tenant/mcp',
    });
    expect(inserted.statusCode).toBe(200);
    expect(inserted.body).toBe(suffix.body);
    const md = inserted.json() as { resource: string; authorization_servers: string[] };
    expect(md.resource).toContain('/api/v1/tenant/mcp');
    expect(md.authorization_servers[0]).toContain('/api/v1/tenant/mcp');
  });
  // RFC 9728, which the MCP spec makes a MUST: the 401 is what points an
  // undiscovered client at the authorization server. This shipped without the
  // header — it was set only on the success reply, i.e. on the one response a
  // client that already has a token does not need it on. A spec-compliant
  // client could not discover this surface, and Claude specifically will not
  // honour the header on a 200.
  it('401 on the MCP endpoint carries the WWW-Authenticate discovery hint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    expect(res.statusCode).toBe(401);
    const header = res.headers['www-authenticate'];
    expect(header).toBeDefined();
    expect(String(header)).toContain('Bearer');
    // Must name the protected-resource document, not just the scheme —
    // that URL is the whole point of the cascade.
    expect(String(header)).toContain('resource_metadata=');
    expect(String(header)).toContain('/.well-known/oauth-protected-resource');
  });

  it('a bad bearer gets the same hint as a missing one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: 'Bearer rp_op_definitely-not-a-real-token' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    expect(res.statusCode).toBe(401);
    expect(String(res.headers['www-authenticate'])).toContain('resource_metadata=');
  });
});
