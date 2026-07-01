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
});
