/**
 * Dynamic client registration (RFC 7591) on the operator authorization server
 * can be closed with OPERATOR_MCP_DYNAMIC_REGISTRATION. Its tokens are
 * workspace-wide admin credentials, and an anonymous registration is how an
 * attacker gets an allowlisted redirect_uri for a consent-phishing link.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

/** Claude Desktop's real callback, a REMOTE https URL, not a loopback one. */
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

describe('operator MCP dynamic client registration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    delete process.env.OPERATOR_MCP_DYNAMIC_REGISTRATION;
  });

  it('OPERATOR_MCP_DYNAMIC_REGISTRATION=disabled refuses anonymous registration', async () => {
    process.env.OPERATOR_MCP_DYNAMIC_REGISTRATION = 'disabled';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: ['https://evil.example/cb'], client_name: 'Definitely Claude' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CLIENT_REGISTRATION_DISABLED');
  });

  it('drops registration_endpoint from RFC 8414 metadata when disabled', async () => {
    // A client that reads the document knows to ask the operator for a
    // client_id rather than retrying a 403 forever. Mirrors the per-app twin.
    process.env.OPERATOR_MCP_DYNAMIC_REGISTRATION = 'disabled';
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/mcp/.well-known/oauth-authorization-server',
    });
    expect(res.json()).not.toHaveProperty('registration_endpoint');
    // The rest of the document is unaffected, clients already holding a
    // client_id keep working.
    expect(res.json()).toHaveProperty('token_endpoint');
  });

  it('an unrecognised value falls back to the boot-validated mode, never to a typo', async () => {
    process.env.OPERATOR_MCP_DYNAMIC_REGISTRATION = 'disabeld';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: [REDIRECT] },
    });
    expect(res.statusCode).toBe(201);
  });
});
